---
layout: module
title: "Module 11: Troubleshooting a Real Deployment"
slug: 11-troubleshooting
meta:
  part: Part IV — Operations
  subtitle: The debugging ladder and three real bugs fixed by this project
---

# Module 11: Troubleshooting a Real Deployment

Debugging is not guessing. It is a methodical narrowing of the system until the failing
component is unambiguous. This module teaches that method, then applies it to the three real
bugs this project hit: a Kubernetes authentication failure, a registry data-plane 503, and a
cross-architecture crash loop. All of these were encountered while deploying Online Boutique to
the Floci EKS `dev-cluster`, and each one is documented in
`eksSetup/Error_Documentation.md`.

## Learning Objectives

By the end of this module you will be able to:

- Work the "debugging ladder" from pod state through logs to the platform layer, in order.
- Explain every pod lifecycle state and name the event that typically produces it.
- Use `kubectl get/describe/logs/exec/top` and `kubectl run` `nettest` as a diagnostic kit.
- Distinguish an application crash from a readiness failure from an infrastructure failure
  by reading `Events` before touching logs.
- Reproduce, diagnose, and fix the three documented bugs (auth, ECR 503, cartservice arch).
- Apply a reusable 5-Whys diagnosis template to any new fault.

## Prerequisites

Modules 01, 02, 04, 05, 06, 07, 08. You need a working `kubectl` against `dev-cluster`
(`kubectl get nodes` must succeed) and the shop deployed to `online-boutique` as in Module 10.

## Time estimate

Reading: 60 min · Hands-on: 90 min

## Concepts

On Kubernetes, a symptom hardly ever tells you the root cause by itself. "The pod is
CrashLoopBackOff" does not say whether the image is missing, the binary is the wrong
architecture, or the process exits because a config file is absent. The debugging ladder is a
disciplined way to peel the onion one layer at a time.

### The debugging ladder

Work top to bottom. Each rung is cheaper than the next and rules out a whole category of
causes. Do not skip rungs: jumping straight to logs is the most common beginner mistake.

```
        +-----------------------------------------------------------------+
        |  6. PLATFORM      docker, registry (Floci ECR), node, registry  |
        |                    mirror, network (floci-net)                  |
        +-----------------------------------------------------------------+
        |  5. RESOURCES     kubectl top pods / kubectl top nodes          |
        +-----------------------------------------------------------------+
        |  4. CONNECTIVITY  kubectl exec <pod> -- ...  /  busybox nettest |
        +-----------------------------------------------------------------+
        |  3. LOGS          kubectl logs <pod> -n online-boutique         |
        +-----------------------------------------------------------------+
        |  2. DESCRIBE      kubectl describe pod  -> Events & Conditions  |
        +-----------------------------------------------------------------+
        |  1. STATE         kubectl get pods -n online-boutique -o wide   |
        +-----------------------------------------------------------------+
```

Rung 1, `kubectl get`: establish what state the objects are in right now, including which
node each pod landed on and its IP. Rung 2, `kubectl describe`: read the `Events:` block, the
`Conditions:` list, and the probe configuration; the scheduler, kubelet, and CRI all write
their conclusions here. Rung 3, `kubectl logs`: now that you know the container actually
started and why it is being restarted, read what the application itself printed. Rung 4,
connectivity: run something inside the pod (or a temporary `busybox` probe) to test DNS and
service reachability. Rung 5, `kubectl top`: check whether the node is out of CPU/memory, which
causes evictions and scheduling failure. Rung 6, platform: step outside Kubernetes entirely —
is Docker up, is the registry reachable, does the node have the right architecture, is the
user-defined network `floci-net` wired correctly.

### Pod lifecycle states

A pod has a coarse `STATUS` column that is really the phase of the whole pod, and finer
container states that the kubelet manages. Both appear in `kubectl get pods`. You need both.

| Status / phase | What it means | Event that typically caused it |
|---|---|---|
| `Pending` | The API server accepted the object; no container runs yet. The scheduler has not placed it, or the kubelet cannot start it. | `FailedScheduling` (insufficient CPU/memory, no matching node); PVC `Waiting`; image not yet pulled. |
| `ContainerCreating` | The pod is bound to a node; the kubelet is pulling images/starting the sandbox. | `Pulling`, `FailedCreatePodSandBox`, slow registry mirror. |
| `Running` | At least one container is up. Note: `Running` does NOT mean `Ready` — the readiness probe may still be failing. | `Started`; `Unhealthy` (readiness) keeps it `Running` but `0/1`. |
| `CrashLoopBackOff` | A container started, then exited with a nonzero code, repeatedly. The kubelet backs off restarts exponentially. | `BackOff`, `Unhealthy`; caused by app panic/exception, wrong config, missing binary, or a platform mismatch such as an arm64 pod trying Rosetta. |
| `ErrImagePull` | The kubelet tried to pull the image and failed (bad credentials, bad tag, no network path to the registry). | `Failed` with reason `ErrImagePull`; `FailedScheduling` is NOT involved. |
| `ImagePullBackOff` | The kubelet gave up retrying for now after repeated `ErrImagePull`, with exponential backoff. | Repeated `Failed`/`ErrImagePull`; registry unreachable, image nonexistent. |
| `Init:<state>` | One or more init containers is running or blocked, e.g. `Init:0/2`, `Init:ErrImagePull`, `Init:CrashLoopBackOff`. The main container waits until they all exit 0. | `Created` init container; the loadgenerator's `frontend-check` init container is a real example. |
| `Completed` | All containers exited 0 (expected for one-shot jobs). | `Completed` reason `Completed`. |
| `Terminating` | Deletion is in progress; the kubelet is draining the pod and waiting out `terminationGracePeriodSeconds`. | `Killing`, `Deleted`. |

The `describe` rung turns a cryptic state into a story: the `Events:` list at the bottom of
`kubectl describe pod` is a chronological log of exactly what the scheduler and kubelet did and
why. Always read it.

### Commands every engineer must know

All examples below are real, run against this project. Their output shapes are shown as you
would actually see them.

```bash
# Rung 1 - state, node, and pod IP for the whole shop
kubectl get pods -n online-boutique -o wide
# NAME                                READY   STATUS      RESTARTS   AGE   IP           NODE
# adservice-7c4d5f9f8b-abc12          1/1     Running     0          9m    10.42.0.20   dev-cluster
# cartservice-cbf67cdcf-xyz34         1/1     Running     0          9m    10.42.0.19   dev-cluster
# frontend-b479f8c7d-9mnop            1/1     Running     0          9m    10.42.0.15   dev-cluster

# Rung 2 - the event log, most recent 25 lines
kubectl get events -n online-boutique --sort-by=.lastTimestamp | tail -25
# LAST SEEN   TYPE      REASON            OBJECT             MESSAGE
# 4m          Normal   Scheduled         pod/cartservice-.. Scheduled successfully
# 4m          Normal   Pulled            pod/cartservice-.. Container image already present on machine
# 4m          Normal   Created           pod/cartservice-.. Created container server
# 4m          Normal   Started           pod/cartservice-.. Started container server

kubectl describe pod cartservice-cbf67cdcf-xyz34 -n online-boutique
# ... Conditions:  Ready=True ...
# Events: <--- the useful part
#   Type     Reason             Age   From               Message
#   ----     ------             ----  ----               -------
#   Normal   Scheduled          9m    default-scheduler  Successfully assigned ...

# Rung 3 - what the app printed
kubectl logs cartservice-cbf67cdcf-xyz34 -n online-boutique --tail=30
# Now listening on: http://[::]:7070

# Rung 4 - test DNS + connectivity from inside the cluster
kubectl run nettest --rm -i --image=busybox:1.38.0 -- getent hosts cartservice
# 10.43.200.7  cartservice.online-boutique.svc.cluster.local

kubectl exec deploy/frontend -n online-boutique -- wget -qO- http://cartservice:7070 2>&1 | head -3

# Rung 5 - are we resource-constrained?
kubectl top pods -n online-boutique
# NAME                            CPU(cores)   MEMORY(bytes)
# frontend-b479f8c7d-9mnop        3m           28Mi

# Rung 6 - is the rollout healthy?
kubectl rollout status deployment/cartservice -n online-boutique
# deployment "cartservice" successfully rolled out
```

Note the `--rm -i` flags on `kubectl run nettest`: the pod is deleted when the command exits,
so you leave no junk behind. `busybox:1.38.0` is the same multi-arch image the upstream
loadgenerator init container already pulls, so it is guaranteed available to the node.

### Reading `Events` before logs: crash vs readiness vs infrastructure

The single most useful habit is classifying the failure from `describe` output before opening
logs. Three categories cover almost everything:

1. **Infrastructure** — image pull or platform. The `Events:` block shows `Failed` /
   `ErrImagePull`, `FailedCreatePodSandBox`, `FailedScheduling`, or a `Back-off pulling image`.
   Logs will not help: the container never started. Investigate the registry, the image tag,
   the node architecture, and the network.
2. **Readiness failure** — the container runs but the probe fails. `Events:` show `Unhealthy`
   on a `readinessProbe`/`livenessProbe`, the pod is `Running` but `READY 0/1`, and it never
   joins the Service endpoints. Check the probe path/port and the service's targetPort.
3. **Application crash** — the container starts and dies. `Events:` show `BackOff` /
   `CrashLoopBackOff`, RESTARTS climbing, but a successful `Started` first. Now, and only now,
   logs are the right tool: a Go panic, a .NET unhandled exception, a missing config.

The ordering matters: if `Events` already say `ErrImagePull`, spending ten minutes reading logs
is wasted because there are no logs. Let the events place the failure in a layer; then open the
logs for that layer.

### CASE STUDY 1 — kubectl auth failure (real bug #1)

Documented as `EKS_TOKEN_WEBHOOK_REJECTS_TEST_CREDS` in `eksSetup/Error_Documentation.md`.

**Symptom.** Every host-side `kubectl` call fails:

```text
$ kubectl get nodes
E0924 ... "couldn't get current server API group list: the server has asked for
the client to provide credentials"
error: You must be logged in to the server (the server has asked for the
client to provide credentials)"
```

**Diagnosis.** Two facts looked contradictory, so we verified them separately:

```bash
aws eks describe-cluster --name dev-cluster --profile floci-eks   # Cluster ACTIVE, healthy
docker exec floci-eks-dev-cluster kubectl get nodes               # works INSIDE k3s
kubectl get nodes                                                 # fails on the HOST
docker logs floci-eks-dev-cluster 2>&1 | grep -i "invalid bearer"
# authentication.go: "Unable to authenticate the request" err="invalid bearer token"
```

The cluster is up and the API server is reachable. Only client credentials are rejected. The
kubeconfig written by `aws eks update-kubeconfig` uses an **exec credential plugin**: every
`kubectl` call runs `aws eks get-token`, which returns a SigV4-presigned STS `GetCallerIdentity`
URL signed by your access key. Floci's k3s token webhook (`/_floci/eks/clusters/dev-cluster/
token-webhook`) validates that token via a `TokenReview`. The original setup used the public
local-development key pair `test`/`test` — and Floci deliberately rejects it, because a positive
TokenReview grants `system:masters` (cluster-admin). The webhook returned `authenticated: false`.

Confirmed by probing the webhook directly:

```bash
TOKEN=$(aws eks get-token --cluster-name dev-cluster --query status.token --output text)
curl -s -X POST http://localhost:4566/_floci/eks/clusters/dev-cluster/token-webhook \
  -H 'Content-Type: application/json' \
  -d "{\"apiVersion\":\"authentication.k8s.io/v1\",\"kind\":\"TokenReview\",\"spec\":{\"token\":\"$TOKEN\"}}"
# signed with test/test  -> {"status":{"authenticated":false}, ...}
```

**Root cause.** A positive TokenReview grants `system:masters`. Floci therefore only trusts
tokens derived from a real IAM access key; the public `test`/`test` pair is refused.

**Fix.** Create a real IAM user and key, store it in a named profile `floci-eks`, regenerate the
kubeconfig so the exec plugin uses that profile, and verify:

```bash
aws iam create-user --user-name eks-admin
aws iam attach-user-policy --user-name eks-admin \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam create-access-key --user-name eks-admin   # note AccessKeyId/SecretAccessKey output

aws configure set aws_access_key_id     <AccessKeyId>     --profile floci-eks
aws configure set aws_secret_access_key <SecretAccessKey> --profile floci-eks
aws configure set region                us-east-1         --profile floci-eks
aws configure set endpoint_url          http://localhost:4566 --profile floci-eks

aws eks update-kubeconfig --name dev-cluster --profile floci-eks
kubectl get nodes
kubectl auth whoami
# Username: floci:aws-iam, Groups: [system:masters ...]
```

`kubectl auth whoami` is the final proof: it shows what identity the API server accepted. The
whole procedure is reproducible with `onlineBoutique/scripts/01-fix-eks-auth.sh`, which is
idempotent and fails fast if `kubectl get nodes` still does not work.

### CASE STUDY 2 — ECR `/v2/` 503 (real bug #2)

Documented as `ECR_DATA_PLANE_503_CONTAINER_DNS` in `eksSetup/Error_Documentation.md`.

**Symptom.** Pushing a built image fails, even though the registry's management API works:

```text
$ docker push 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7
unknown: unexpected status from HEAD request to
  http://000000000000.dkr.ecr.us-east-1.localhost:4566/v2/microservices-demo/frontend/blobs/...: 503 Service Unavailable
```

**Diagnosis.** Separate the **control plane** from the **data plane**. Control-plane calls
(`aws ecr create-repository`, `describe-repositories`) succeeded. Data-plane calls
(everything under `/v2/`, which is blob/blob-upload HTTP traffic) returned `503` with an empty
body. The Floci-facing registry itself was healthy: `curl http://127.0.0.1:5100/v2/` returned
200. So the failure is between `docker push` and the registry — a proxy problem.

```bash
docker exec floci getent hosts floci-ecr-registry   # on default bridge: no resolution / refuse
```

**Root cause.** Floci runs inside a Docker container and proxies `/v2/...` traffic to its
backing `registry:2` sidecar, which it reaches **by container name**
(`http://floci-ecr-registry:5000`). The default Docker `bridge` network has **no
container-name DNS**. With no way to resolve its own sidecar, the proxy returned `503`.

**Fix.** Put the containers on a user-defined network (`floci-net`), which comes with embedded
DNS, then verify:

```bash
docker network create floci-net
docker network connect floci-net floci
docker network connect floci-net floci-ecr-registry
docker network connect floci-net floci-eks-dev-cluster   # k3s + its svclb pods too

curl -s -o /dev/null -w "%{http_code}\n" \
  http://000000000000.dkr.ecr.us-east-1.localhost:4566/v2/   # 200
```

The heal script `onlineBoutique/scripts/01-fix-floci-network.sh` automates exactly this. It
creates `floci-net` if absent, attaches all three containers idempotently, checks `docker login`,
and verifies `/v2/` returns 200. `03-build-push-images.sh` invokes it before every push.

The do-not-recreate lesson: the stock Floci image runs `FLOCI_STORAGE_MODE=memory`, so the
`dev-cluster` metadata lives only in the running container. Recreating the `floci` container
would lose the cluster. The durable fix re-applies networking to the running containers (Docker
persists network membership across daemon restarts) and fixes the launch config for fresh
setups.

### CASE STUDY 3 — cartservice rosetta error (real bug #3)

**Symptom.** `cartservice` pods never start:

```text
$ kubectl get pods -n online-boutique -l app=cartservice
NAME                          READY   STATUS             RESTARTS   AGE
cartservice-cbf67cdcf-xyz34   0/1     CrashLoopBackOff   5          4m
```

`kubectl logs` shows the telltale error:

```text
$ kubectl logs <cartservice-pod> -n online-boutique --tail=30
rosetta error: failed to open elf at /lib64/ld-linux-x86-64.so.2
```

**Diagnosis.** The `Events:` block showed the image pulled and containers created — purely an
application/platform crash. The message names Rosetta: Docker Desktop's x86 emulation on this
arm64 node tried to load an **amd64 executable**. The `cartservice` Dockerfile
(`src/cartservice/src/Dockerfile`) declares `ARG TARGETARCH=amd64` as a default. Building with
`docker buildx build --platform linux/arm64` without overriding it produced an **amd64 binary
inside an image labeled arm64**. On the arm64 k3s node, containerd ran the container as arm64,
but its ELF entry point was x86-64, whose interpreter `/lib64/ld-linux-x86-64.so.2` cannot be
opened under emulation.

**Fix.** Force the build variables through, push the corrected image, evict the cached digest,
and delete the old pod:

```bash
docker buildx build \
  --platform linux/arm64 \
  --build-arg BUILDPLATFORM=linux/arm64 \
  --build-arg TARGETARCH=arm64 \
  --build-arg TARGETOS=linux \
  -f microservices-demo/src/cartservice/src/Dockerfile \
  -t 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/cartservice:v0.10.7 \
  microservices-demo/src/cartservice/src

docker push 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/cartservice:v0.10.7

# k3s containerd caches by tag (imagePullPolicy: IfNotPresent) -> evict the stale image
docker exec floci-eks-dev-cluster crictl rmi \
  000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/cartservice:v0.10.7

kubectl delete pod -n online-boutique -l app=cartservice   # recreate from the Deployment
```

Verify the container actually serves:

```bash
kubectl logs -n online-boutique -l app=cartservice --tail=30
# Now listening on: http://[::]:7070
kubectl get pods -n online-boutique -l app=cartservice     # READY 1/1
```

The `crictl rmi` step is essential. The shop's pods use `imagePullPolicy: IfNotPresent`, so
containerd proudly reports "image already present" for the stale tag unless you evict it first.
This was such a recurring trap that `03-build-push-images.sh` now always forces the arch args
and evicts the cached image after each push.

### The 5-Whys diagnosis template

Reuse this shape whenever something breaks. Filling it in forces you through the ladder instead
of guessing.

```
S1. SYMPTOM      What is the exact error/status? (copy the text, not "it's broken")
S2. TARGET       What object/container/image is failing?
S3. EVIDENCE     Rung by rung, what did get/describe/logs/exec/top say?
                 (paste the Events you trust: Scheduled? Pulled? BackOff? ErrImagePull?)
S4. CLASSIFY     Infrastructure / readiness / application crash? (from Events, not logs)
S5. 5 WHYS       Why? -> because X. Why? -> because Y. ... until the root cause is a
                 concrete fact you can act on. Then: the fix, and how you verified it.
```

Checklist of honest "why" answers to reach for: wrong image tag, image not pushed, registry
unreachable, wrong profile/credentials, wrong arch/label, cached tag, port mismatch, probe
miscounting `port` vs `targetPort`, namespace forgotten, Service selector not matching pod
labels.

## Hands-On Lab

Restore the shop first if needed: `kubectl apply -f manifests/kubernetes-manifests.yaml
-n online-boutique` and wait for rollouts with `scripts/04-deploy.sh`. Everything below is
non-destructive — every broken object is deleted or scaled back at the end.

### Lab A — reproduce ImagePullBackOff in two commands

Create a Deployment whose image cannot exist, then watch the ladder classify it:

```bash
kubectl create deploy bad --image=nonexistent/repo:v9 -n online-boutique
kubectl get pods -n online-boutique -l app=bad -w
# NAME                   READY   STATUS             RESTARTS   AGE
# bad-6f5bd75c6f-xxxxx   0/1     ErrImagePull       0          8s
# bad-6f5bd75c6f-xxxxx   0/1     ImagePullBackOff   0          22s
```

Now the `describe` rung — observe that the `Events:` block, not logs, carries the diagnosis:

```bash
kubectl describe pod -n online-boutique -l app=bad | tail -15
# Events:
#   ... Failed   Pulling image "nonexistent/repo:v9"
#   ... Failed   Failed to pull image "nonexistent/repo:v9": ... not found
#   ... Warning  Failed   Error: ErrImagePull
#   ... Warning  BackOff  Back-off pulling image "nonexistent/repo:v9"
```

Answer for yourself: how did Events classify this? (Infrastructure — image pull.) Clean up:

```bash
kubectl delete deploy bad -n online-boutique
```

### Lab B — break and fix cartservice

Inject a real fault the same way an incident might surface: scale a needed backend to zero.

```bash
kubectl scale deploy cartservice -n online-boutique --replicas=0
kubectl get pod -n online-boutique -l app=cartservice      # No resources found

# The frontend still serves pages, but cart/checkout calls fail:
kubectl logs deploy/loadgenerator -n online-boutique --tail=20 --follow
# watch for non-200 responses and cart-service connection errors
```

While it is down, read the events to see the "Missing Pod" trail:
`kubectl get events -n online-boutique --sort-by=.lastTimestamp | tail -25`.

Restore and confirm recovery — note the readiness probe has to pass again before the pod is
`READY 1/1`:

```bash
kubectl scale deploy cartservice -n online-boutique --replicas=1
kubectl rollout status deployment/cartservice -n online-boutique   # successfully rolled out
kubectl get pods -n online-boutique -l app=cartservice              # 1/1 Running
kubectl logs deploy/loadgenerator -n online-boutique --tail=20      # errors back to 0
```

### Lab C — check cross-service DNS with nettest

```bash
kubectl run nettest --rm -i --image=busybox:1.38.0 \
  -- getent hosts cartservice
# 10.43.200.7    cartservice.online-boutique.svc.cluster.local

kubectl run nettest --rm -i --image=busybox:1.38.0 \
  -- getent hosts redis-cart
kubectl run nettest --rm -i --image=busybox:1.38.0 \
  -- nslookup frontend | tail -6
```

Then prove the Service actually forwards: connect to it from inside the cluster and observe the
round-robin across replicas (scale frontend to 3 first if you want to see it spread).

### Lab D — interpret real events

Run `kubectl get events -n online-boutique --sort-by=.lastTimestamp | tail -25` and write one
sentence for at least three lines you have not seen before. Example pairs:

- `Scheduled ... Successfully assigned` — the scheduler placed the pod on a node.
- `Pulled ... Container image already present on machine` — the `IfNotPresent` cache hit
  (remember CASE STUDY 3).
- `Warning BackOff ... Back-off restarting failed container` — the kubelet is staggering a
  crashing container (remember the crash vs readiness vs infra rule).

## Common Pitfalls

- **Reading logs before events.** On `ErrImagePull` or `FailedScheduling` there are no logs;
  the Events block is the only evidence. Classify first.
- **Forgetting the namespace.** `kubectl get pods` with no `-n online-boutique` shows an empty
  `default` namespace and sends you hunting for a problem that does not exist.
- **Trusting the tag cache.** `imagePullPolicy: IfNotPresent` plus a re-pushed tag reuses the
  stale digest. After a rebuild, `crictl rmi` in the k3s node (CASE STUDY 3).
- **Confusing `Running` with `Ready`.** A pod can run while never joining Service endpoints.
  Check `READY 0/1` and the readiness probe, then the Service `targetPort`.
- **Ignoring architecture.** On an arm64 node, an amd64 image fails at exec time with
  `rosetta error`, not at pull time. The image pulled fine — the platform rejected the binary.
- **Assuming `ACTIVE` means accessible.** The cluster was `ACTIVE` while every kubectl call
  failed (CASE STUDY 1). Always verify with `kubectl get nodes`, then `kubectl auth whoami`.
- **Recreating the Floci container "to fix it".** Its metadata is in-memory; recreation orphans
  the cluster. Fix the network wiring instead (CASE STUDY 2).

## Key Takeaways

- Work the ladder in order: state, describe/events, logs, exec/nettest, top, then platform.
- Read the `Events:` block to classify a failure as infrastructure, readiness, or app crash
  before you read any logs.
- Every pod state (Pending, ContainerCreating, CrashLoopBackOff, ErrImagePull, etc.) is the
  output of a specific event; the events tell you which.
- The three real bugs are patterns, not one-offs: webhook rejects default creds; container-name
  DNS disappears off a user-defined network; a wrong-arch binary fails at exec, not pull.
- When you re-push an image under the same tag, evict the cached image or the node keeps the
  old digest.
- Write down your diagnosis as symptom -> events -> classification -> 5 Whys so the fix is a
  conclusion, not a guess.

## Review Questions

1. Put these in the correct order: `kubectl top`, `kubectl logs`, `kubectl get -o wide`,
   `kubectl describe`, `kubectl run nettest`.
2. What event typically causes `ImagePullBackOff`? Where in `kubectl describe pod` do you see
   it?
3. A pod shows `0/1 Running` with RESTARTS slowly climbing. Catastrophize correctly: is this
   likely a readiness failure or an app crash? What one `describe` line would confirm it?
4. In CASE STUDY 1, the cluster reported `ACTIVE` and k3s-internal kubectl worked. Why did
   host-side kubectl still fail?
5. In CASE STUDY 2, why did `curl http://127.0.0.1:5100/v2/` succeed while `docker push` to the
   Floci endpoint returned 503?
6. Why was `crictl rmi` necessary after pushing a fixed cartservice image?
7. Write the 5-Whys chain for the cartservice rosetta error, ending at a concrete fix.

### Answers

1. `kubectl get -o wide`, `kubectl describe`, `kubectl logs`, `kubectl run nettest`/`exec`,
   `kubectl top`.
2. Repeated `ErrImagePull` from the kubelet (image nonexistent, wrong tag, unreachable
   registry), which appears as `Failed`/`BackOff` reasons in the pod's `Events:` block.
3. App crash: the container started then died repeatedly, so `Started` is followed by
   `BackOff`/`CrashLoopBackOff` in Events. A readiness-only failure stays `Running` and `0/1`
   with `Unhealthy` on the readinessProbe.
4. The token webhook rejected the `test`/`test` signed token — the kubeconfig exec plugin was
   producing a token Floci refuses, so the API server asked the client to provide credentials.
5. The registry itself was healthy; the 503 came from Floci's proxy, which resolves its
   `floci-ecr-registry` sidecar by container name — impossible on the default bridge (no DNS).
6. The node runs `imagePullPolicy: IfNotPresent` and caches by tag, so it would reuse the stale
   amd64 digest instead of pulling the corrected arm64 one.
7. Symptom: CrashLoopBackOff. Why? Container exits at exec. Why? `rosetta error ... failed to
   open elf`. Why? The binary is x86-64. Why? The Dockerfile defaulted `TARGETARCH=amd64` and
   the build did not override it. Why? The build args were not forced. Fix: build with
   `--build-arg TARGETARCH=arm64`, push, `crictl rmi`, delete the pod.
