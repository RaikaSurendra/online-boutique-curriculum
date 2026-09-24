---
layout: module
title: "Module 12: Capstone & Final Exam"
slug: 12-capstone-final-exam
meta:
  part: Part IV — Operations
  subtitle: Deploy, scale, observe, troubleshoot; 30-question exam with answers
---

# Module 12: Capstone & Final Exam

This module closes the course. You will do the work yourself: onboard to the environment,
deploy and scale a live service, break it on purpose and recover it, and then sit a written
exam that spans every module from 00 to 11. The capstone is graded from the evidence your
terminal produced; the exam has a full answer key at the end.

## Learning Objectives

By the end of this module you will be able to:

- Complete the full onboard-to-recover lifecycle of the shop on the Floci EKS `dev-cluster`
  without hand-holding.
- Deploy, scale, observe, and restore a real Online Boutique service, capturing evidence of
  every step.
- Run any of the six scripts (`00-env` through `99-cleanup`) correctly and explain what each
  one guards against.
- Explain how this local stack maps to real AWS EKS/ECR, and what changes vs. what stays the
  same.
- Answer 30 written questions covering everything in the tutorial and defend every answer.

## Prerequisites

Modules 01 through 11. You must already have the cluster running (`kubectl get nodes` works via
profile `floci-eks`), the images pushed to the Floci ECR registry
(`000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/<svc>:v0.10.7`), and the shop
deployed into namespace `online-boutique`.

## Time estimate

Capstone: ~165 min (30 + 60 + 45 + 30). Final exam: 120 min. Written assessment: 90 min.

## Concepts

### The Capstone Project

The capstone is a scenario, not a video demo. You are a platform engineer who just inherited a
running shop and must prove you can operate it. Work through the four parts and capture the
evidence listed under each. Evidence means pasted terminal output plus a one-line caption per
step saying what it proves.

**Part A — Onboard to the environment (30 min).**

Run the bootstrap scripts in dependency order. They are idempotent, so it is safe to re-run.
Verify each effect before moving on.

```bash
source scripts/00-env.sh                 # sets AWS_PROFILE=floci-eks, ECR registry, tag v0.10.7
scripts/01-fix-eks-auth.sh               # ensures host kubectl can authenticate to dev-cluster
scripts/01-fix-floci-network.sh          # ensures the ECR /v2/ data plane is reachable
kubectl get nodes -o wide                # dev-cluster, arm64 node: Ready
kubectl auth whoami                      # shows the accepted identity (floci:aws-iam, system:masters)
kubectl get pods -n online-boutique      # shop is healthy before you start
```

Evidence to capture:

- `kubectl get nodes` showing `dev-cluster` `Ready`, plus the `ARM64`/`aarch64` architecture.
- The `01-fix-eks-auth.sh` final "Verified:" block (`kubectl get nodes` + `kubectl auth whoami`).
- `curl -s -o /dev/null -w "%{http_code}" http://000000000000.dkr.ecr.us-east-1.localhost:4566/v2/`
  returning `200` after `01-fix-floci-network.sh`.

**Part B — Deploy a brand-new service (60 min).**

Pick ONE service you have not personally moved this way (everyone on a team should pick a
different one). Good choices: `adservice`, `paymentservice`, `shippingservice`, `emailservice`,
`productcatalogservice`, `currencyservice`, `recommendationservice`. Do NOT pick `frontend`,
`cartservice`, or `redis-cart` for this part — reserve those.

1. Read its block in `manifests/kubernetes-manifests.yaml` (the upstream
   `release/kubernetes-manifests.yaml` rewritten to the Floci ECR registry).
2. In writing: explain the Deployment and the Service — the selector to `app: <svc>`, the
   container port, the probe types (`grpc`/`httpGet`/`tcpSocket`) and their ports, and the
   Service's `port` vs `targetPort` (a mismatched pair is a classic fault, Module 05).
3. Delete your chosen Deployment only, then re-create it from the manifest, or scale it to `3`
   and back:

```bash
kubectl scale deployment <svc> -n online-boutique --replicas=3
kubectl get deploy <svc> -n online-boutique -o wide        # DESIRED/AVAILABLE 3/3
kubectl rollout status deployment/<svc> -n online-boutique
kubectl top pods -n online-boutique | grep <svc>           # three pods, per-pod CPU/mem

kubectl scale deployment <svc> -n online-boutique --replicas=1
kubectl rollout status deployment/<svc> -n online-boutique
```

Evidence to capture: your written explanation; `kubectl get deploy -o wide` at 3/3; the rollout
output; `kubectl top pods` showing all three replicas. Then confirm the Service still fans out
correctly with the `nettest` pattern from Module 11
(`kubectl run nettest --rm -i --image=busybox:1.38.0 -- getent hosts <svc>`).

**Part C — Observe and troubleshoot (45 min).**

Deliberately introduce a real fault, then write the incident report. Recommended fault: scale
`cartservice` to zero — this breaks cart and checkout flows while the frontend stays up.

1. Introduce the fault: `kubectl scale deployment cartservice -n online-boutique --replicas=0`.
2. Observe: `kubectl get pods -n online-boutique -l app=cartservice` (gone), then
   `kubectl get events -n online-boutique --sort-by=.lastTimestamp | tail -25`.
3. Prove the blast radius: the shop's frontend still serves, but cart/checkout API calls return
   errors. Capture loadgenerator output: `kubectl logs deploy/loadgenerator -n online-boutique
   --tail=20`.
4. Diagnose using the Module 11 ladder. Write the 5-Whys chain and classify the failure
   (note: scaling to zero is a "desired replica count says 0" condition, which you can see in
   `kubectl describe deployment cartservice -n online-boutique` as `replicas: 0`).
5. Fix: `kubectl scale deployment cartservice -n online-boutique --replicas=1`, then
   `kubectl rollout status deployment/cartservice -n online-boutique`.
6. Verify recovery: `kubectl get pods -n online-boutique -l app=cartservice` is `1/1 Running`;
   loadgenerator errors return to zero; a browser or `kubectl port-forward svc/frontend-external
   8080:80` cart flow succeeds again.

Deliverable: a short report with the five sections — Symptoms, `describe` output (Events),
Root cause, Fix, How you verified recovery. Restore the shop to its original state
(`cartservice` at 1 replica) at the end.

**Part D — Reflect (30 min).**

Answer in writing, 2-4 sentences each:

1. This shop is a monolith of eleven microservices. Give the tradeoffs — when does a
   microservice split pay off, and when is a monolith the better engineering choice?
2. Why does Floci deliberately reject the public `test`/`test` key pair at the Kubernetes token
   webhook, and what did the fix (`eks-admin` user + `floci-eks` profile) change?
3. Why did the ECR `/v2/` data plane need a user-defined Docker network (`floci-net`) rather
   than the default bridge?
4. What does the `IfNotPresent` caching mistake (CASE STUDY 3 in Module 11) teach you about
   image tags and rollouts?
5. You must take this shop to real AWS. List the concrete resources you would create and the
   first three things that would break if you reused the local scripts unchanged.

### Grading rubric

| Criterion | Excellent | Passing | Not passing |
|---|---|---|---|
| Part A — Onboarding | All three scripts run clean; evidence shows Ready node, `whoami` identity, `/v2/` 200 | Scripts run; evidence mostly complete | Cannot bring cluster into a working state; missing core evidence |
| Part B — Deploy & scale | Written explanation correct on selector/port/probes; scaling evidence complete (3/3, rollout, top, nettest) | Service deployed and scaled; explanation has one minor gap | Service never reaches 3/3, or no written explanation |
| Part C — Troubleshoot | Report has all 5 sections; 5-Whys root cause is correct and matches events; recovery verified | Fault introduced and fixed; report has the 5 sections with minor gaps | Fault not restored, or report missing root cause |
| Part D — Reflection | Arguments are specific and technically correct across all five questions | Reasonable answers, mostly correct | Answers are vague or incorrect |
| Final exam | 80%+ | 60-79% | Below 60% |

### What's next: going to real AWS

Everything you built maps to a real EKS deployment. The concepts carry over wholesale; the
addresses and sidecars do not.

**What changes:**

- **Region and account.** `000000000000.dkr.ecr.us-east-1.localhost:4566` becomes a real ECR URI,
  e.g. `123456789012.dkr.ecr.us-east-1.amazonaws.com`. The `.localhost:4566` hostname and
  `endpoint_url` disappear; real ECR runs on the standard public host.
- **Cluster.** `dev-cluster` (single k3s container) becomes a real EKS control plane with one or
  more **managed node groups** (not a single emulated node), typically across multiple
  Availability Zones with an auto-scaler.
- **IAM.** An admin user with `AdministratorAccess` is far too broad. Real EKS uses the
  **EKS Node IAM role** for the nodegroup plus cluster role bindings (e.g. `eks-admin` mapped via
  `aws-auth` ConfigMap) and an OIDC identity provider for pod identities; `kubectl auth whoami`
  still works but grants a scoped role, not `system:masters`.
- **Networking.** In Floci, `npm`-style container DNS was the bug; on real EKS, VPC subnets,
  security groups, and an AWS Load Balancer Controller provide the `LoadBalancer` Service that
  stays `Pending` on Floci. Real `frontend-external` gets a real ELB/ALB hostname instead of a
  `port-forward`.
- **Registry access.** k3s's `registries.yaml` mirror is replaced by `imagePullSecret` + IAM
  permission for ECR, or the node IAM role assuming `AmazonEC2ContainerRegistryReadOnly`.
- **update-kubeconfig.** The command works without a local `endpoint_url`, hitting the real
  `https://<cluster>.<region>.eks.amazonaws.com` endpoint; the exec credential plugin and the
  token-webhook flow are the same ideas but the webhook is AWS EKS's, not Floci's.

**What stays the same:**

- Every Kubernetes concept: Deployments, Services, selectors, probes, init containers,
  resources, namespaces, DNS service discovery, rollouts, `kubectl` itself.
- The manifest structure; `kubernetes-manifests.yaml` applies on real EKS almost unchanged
  apart from image URIs.
- The debugging ladder (Module 11) and all the `kubectl` commands; `describe` Events, `logs`,
  `top`, `rollout status` work identically.
- Observability habits, `kubectl top`, the load generator, and the systemic approach of
  separating control plane from data plane.

## Hands-On Lab

The capstone above IS the lab for this module; the graded deliverables (Parts A-D) require live
commands. In addition, run this short end-to-end smoke test to prove everything is still green
before the exam, and leave the environment clean:

```bash
source scripts/00-env.sh
kubectl get nodes -o wide
kubectl get pods -n online-boutique -o wide          # all 1/1
kubectl get svc -n online-boutique                    # cluster IPs, frontend-external pending (expected)
kubectl top pods -n online-boutique 2>/dev/null || echo "(metrics not ready yet)"
kubectl port-forward -n online-boutique svc/frontend-external 8080:80
# new terminal:
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8080    # 200
```

## Common Pitfalls

- **Skipping idempotent preflight.** Re-running `01-fix-eks-auth.sh` and `01-fix-floci-network.sh`
  is harmless and free; a "but it worked before" cluster is exactly the one with a stale network
  wiring after a Docker restart.
- **Scaling the wrong object.** Scale the Deployment (`kubectl scale deploy cartservice`), not the
  Service or Pod; a Service has no replicas.
- **Forgetting to restore.** Part C ends with `cartservice` back at `--replicas=1`; graded work
  always restores the environment.
- **Confusing `port` with `targetPort`** when explaining Part B; the Service `port` is
  what the cluster exposes, `targetPort` is what the container listens on.
- **Reusing local scripts on real AWS unchanged.** `endpoint_url`, the `.localhost` ECR host,
  admin access key, and `system:masters` are local-emulator conveniences that would cost you
  (or your security reviewer) dearly on real AWS.
- **Answering exam questions from memory of the command, not the concept.** The exam rewards
  "why" more than "what".

## Key Takeaways

- You can operate the full lifecycle of a microservice shop: onboard, deploy, scale, observe,
  break, diagnose, recover, and clean up.
- The six scripts encode hard-won root causes (auth webhook, ECR data-plane DNS, arm64 builds)
  — reuse them and explain them.
- Capstone evidence, not vibes: terminal output with a caption proves operation skill.
- Every local-emulation quirk has a real-AWS counterpart with the same shape and a different
  product name.
- The debugging ladder and the 5-Whys template are the same everywhere you go.

## Final Exam

Answer all 30 questions. Sections: 12 multiple-choice, 12 short-answer, 6
practical/command-completion. There is no penalty for a wrong guess on the multiple choice, but
short answers are graded on the reasoning, not buzzwords.

### Multiple choice (Q1-Q12)

1. Which best describes why a Docker layer for `COPY . .` must be rebuilt when `src/` changes?
   a) Containers cannot share files. b) Layers are immutable once built; only that layer and
   everything above it change. c) The registry forbids cache reuse. d) Layers are hashed by
   timestamp only.

2. On an arm64 node, an image built for amd64 typically fails at:
   a) `docker login`. b) image pull. c) runtime/execution (e.g. `rosetta error`). d) repository
   creation.

3. Which probe type decides whether a Pod receives traffic from a Service?
   a) livenessProbe. b) readinessProbe. c) startupProbe only. d) no probe.

4. What does an `initContainers` block guarantee before the main container starts?
   a) The main container runs first. b) Init containers run to completion (exit 0) first, in
   order, on the same Pod. c) Exactly one replica exists. d) Images are pulled only once.

5. In the Online Boutique manifest, the `frontend-external` Service is of type:
   a) ClusterIP. b) NodePort. c) LoadBalancer. d) Headless.

6. Which service in the boutique is written in .NET and listens on 7070?
   a) checkoutservice. b) cartservice. c) adservice. d) currencyservice.

7. In the Floci local stack, `dev-cluster` is actually:
   a) managed EKS. b) k3s inside a container. c) minikube. d) a GKE cluster.

8. How does `aws eks get-token` authenticate to the k3s API server's token webhook?
   a) Sends password to the API server. b) STS `GetCallerIdentity` SigV4-presigned URL that the
   webhook verifies. c) SSH key. d) Static bearer of the access key.

9. In a registry, the `/v2/` path is part of the:
   a) control plane. b) data plane. c) IAM. d) cluster.

10. `kubectl top pods` requires which component to be installed?
    a) Prometheus. b) metrics-server. c) Grafana. d) kube-state-metrics.

11. What starts the artificial traffic to the shop?
    a) Jenkins. b) loadgenerator Deployment. c) skaffold. d) Grafana.

12. `kubectl rollout status deployment/cartservice -n online-boutique` tells you:
    a) that cart is healthy now. b) whether the Deployment reached its desired, updated,
    available state. c) resource usage. d) if the image is cached.

### Short answer (Q13-Q24)

13. Explain, in two or three sentences, how multi-stage Docker builds help cross-compile before
    the `FROM ... AS builder` `--platform=$BUILDPLATFORM` line, and why the cartservice
    `TARGETARCH=amd64` default broke the arm64 build.

14. What is the difference between `immutability` of container images and the `IfNotPresent`
    pull policy? Why did `crictl rmi` have to run after re-pushing the fixed cartservice image?

15. A Pod is `Pending`. Name two Events you might see that would explain why, and what each
    means.

16. You see `CrashLoopBackOff` on `cartservice` but no `ErrImagePull` in Events. What is your
    next (second) step on the debugging ladder and why not logs first?

17. Why do users refer to other services by DNS names like `cartservice:7070` instead of IPs?

18. What is the difference between the `LOAD GENERATOR`'s job and the `frontend's` job in this
    architecture, and why is a load generator considered observability tooling?

19. Describe the full token flow that lets `kubectl get pods -n online-boutique` succeed: from
    your IAM profile to the API server accepting the request. Mention exec credential plugin,
    TokenReview, and `system:masters`.

20. A `docker push` to `000000000000.dkr.ecr.us-east-1.localhost:4566/...` fails with `503
    Service Unavailable`, but `aws ecr describe-repositories` works. Diagnose the two layers
    (control vs data plane) and state the fix used in this project.

21. What does the `01-fix-eks-auth.sh` script do, and why is it idempotent (safe to rerun)?

22. To move this store to real AWS, name three infrastructure pieces that would change and the
    concept that stays identical.

23. Explain the tradeoff when you scale `cartservice` to 0 (what breaks, what stays up) and
    what a production operator would do instead of a permanent 0-replica service.

24. Why does `kubectl describe pod` output contain an `Events:` section and why should you read
    it before `kubectl logs`?

### Practical / command completion (Q25-Q30)

Complete or write the command. Use the exact project values (`dev-cluster`, `online-boutique`,
`floci-eks`, ECR registry as given).

25. Show all pods in the shop with node and pod IPs: `kubectl get pods ____ ____`.

26. Regenerate the kubeconfig for `dev-cluster` using profile `floci-eks`:
    `aws eks update-kubeconfig ____`.

27. Check DNS resolution inside the cluster for the `productcatalogservice`:
    `kubectl run nettest --rm -i --image=busybox:1.38.0 -- ____ ____`.

28. Show the most recent 25 events in the shop namespace, oldest of the newest first:
    `kubectl get events ____`.

29. Scale `frontend` to 3 replicas and wait for the rollout:
    `kubectl scale deployment frontend -n online-boutique ____` then
    `kubectl rollout status ____`.

30. Verify your own cluster identity as the API server sees it:
    `kubectl ____`.

## Answer Key

### Q1-Q12

1. **b.** Each build step produces an immutable layer; a changed `COPY` invalidates only that
   layer and the ones depending on it (Module 01).
2. **c.** Image pull is architecture-agnostic at the registry; the failure surfaces at exec time
   on arm64, which is precisely the cartservice `rosetta error` (Module 11, CASE STUDY 3).
3. **b.** `readinessProbe` gates Service endpoints; `livenessProbe` restarts a hung container
   (Module 02).
4. **b.** Init containers run in order and must exit 0 before the main container starts,
   sharing the Pod's network/filesystem (Module 02, loadgenerator's `frontend-check`).
5. **c.** `frontend-external` is `type: LoadBalancer` — it stays `Pending` on Floci and needs
   `port-forward` (Module 05).
6. **b.** cartservice is .NET on 7070; checkout is Go on 5050, adservice is Java on 9555,
   currencyservice is Node on 7000 (Module 04).
7. **b.** Floci emulates EKS with a real k3s v1.34 node in a container on arm64 (Module 06).
8. **b.** Presigned STS identity; Floci's webhook performs a TokenReview (Module 07).
9. **b.** The data plane is `/v2/` blob/blob-upload traffic; `describe-repositories` is control
   plane (Module 08, CASE STUDY 2).
10. **b.** metrics-server; `kubectl top` otherwise errors "(metrics not ready yet)" (Module 09).
11. **b.** `loadgenerator` (Locust-style) drives `frontend:80` at `RATE`/`USERS` (Module 09).
12. **b.** Rollout status reports whether the Deployment reached its desired, updated, available
    state; it is not a health check, hence the "impossible" phrasing.

### Q13-Q24

13. Multi-stage builds separate the builder (which needs full SDK toolchains) from the runtime
    image (slim, no tools). Cross-compilation: the builder `FROM --platform=$BUILDPLATFORM`
    provides the host toolchain, and `ARG TARGETARCH` tells `dotnet publish -a $TARGETARCH`
    which runtime to emit. The cartservice Dockerfile `ARG TARGETARCH=amd64` default made a
    build without `--build-arg TARGETARCH=arm64` emit an x86-64 binary inside an arm64 image,
    which the arm64 node could not execute.

14. Images are immutable: a tag points at one digest at a time. `IfNotPresent` tells the node
    "skip pulling if you already have this tag". After re-pushing a better image under the same
    tag, the node would keep the cached (old) digest, so `crictl rmi` was required to evict it
    and force a re-pull of the corrected image.

15. e.g. `FailedScheduling` (no node meets resource/selector requirements) or `Pulling`/
    `FailedCreatePodSandBox` (image pull or sandbox creation still in progress / failed).
    Also valid: `Failed` with `OutOfmemory`/`Insufficient cpu`.

16. Second rung is `kubectl describe pod <name> -n online-boutique` to read `Events:` —
    classify the failure (app crash vs readiness vs infra) before reading logs. Logs are only
    meaningful once you know the container is the one crashing.

17. Service names are stable DNS identities backed by the Service object; IPs change whenever
    pods are recreated. `cartservice:7070` resolves to the Service ClusterIP, which load-balances
    across the backend pods (Module 05).

18. `frontend` serves the UI and calls the eight gRPC backends (product catalog, cart, currency,
    recommendations, shipping, checkout, ad, shopping assistant disabled). The load generator
    produces synthetic but realistic user traffic so that observability tools (logs, metrics,
    errors) have real signal; without it you would only discover failures manually.

19. `kubectl` invokes the exec credential plugin in the kubeconfig, which runs `aws eks
    get-token` using profile `floci-eks`; the plugin returns a presigned STS `GetCallerIdentity`
    token. The API server forwards it as a TokenReview to Floci's token webhook; the webhook
    verifies the IAM signature and a positive review grants `floci-aws-iam` in `system:masters`.
    `kubectl auth whoami` displays that accepted identity.

20. Control plane (describes, login) lives outside `/v2/` and worked; data plane `/v2/` is
    proxied by Floci to its `floci-ecr-registry` sidecar by container name. The default bridge
    has no container-name DNS, so the proxy 503'd. Fix: `docker network create floci-net`,
    connect `floci`, `floci-ecr-registry`, and `floci-eks-dev-cluster`; verify `/v2/` returns
    200; automate with `01-fix-floci-network.sh` (Module 08, CASE STUDY 2).

21. It creates IAM user `eks-admin` plus an access key, writes them under the `floci-eks`
    profile (leaving `[default]` untouched), runs `aws eks update-kubeconfig --name dev-cluster
    --profile floci-eks`, and verifies with `kubectl get nodes` + `kubectl auth whoami`. It is
    idempotent because it first checks whether those commands already succeed and skips re-creation
    (and re-creating an access key would invalidate the old one).

22. Change: real region/account, real ECR URI + no `endpoint_url`/`.localhost`, real EKS managed
    node groups (multi-AZ) with EKS node IAM role, real ELB/ALB for the LoadBalancer Service, and
    imagePullSecrets/OIDC instead of an admin key. Stays identical: Deployment/Service/selector/
    probe manifest structure, DNS service discovery, the debugging ladder and `kubectl` command
    set, `kubectl top`, rollouts (Module 12 "What's next").

23. Breaking a backend service means cart/checkout paths fail (add to cart, checkout) while the
    read-mostly catalog pages remain up — great for learning blast radius, never an operator
    choice for a permanent state; production would scale to 0 only for scheduled maintenance and
    instead rely on readiness gates, autoscaling, and circuit breakers to degrade gracefully.

24. The `Events:` section records what the scheduler/kubelet/CRI actually did (Scheduled,
    Pulling, Failed, BackOff) — the evidence for *why* the pod is in its state. Logs only exist
    if a container started. Error: `ErrImagePull`/`FailedScheduling` produce no logs at all, so
    reading logs first wastes time and hides the real cause.

### Q25-Q30

25. `kubectl get pods -n online-boutique -o wide`.
26. `aws eks update-kubeconfig --name dev-cluster --profile floci-eks`.
27. `kubectl run nettest --rm -i --image=busybox:1.38.0 -- getent hosts productcatalogservice`.
28. `kubectl get events -n online-boutique --sort-by=.lastTimestamp | tail -25`.
29. `kubectl scale deployment frontend -n online-boutique --replicas=3` and
    `kubectl rollout status deployment/frontend -n online-boutique`.
30. `kubectl auth whoami`.

## Closing

Across this course you built a production-style microservice shop on a Kubernetes/EKS workflow:
you explained images and cross-compilation down to the ELF interpreter, authored and deployed
Deployments, Services, probes, and init containers from a real 980-line manifest, authenticated
to an EKS-style control plane through IAM and a token webhook, pushed to a real registry-backed
ECR data plane, observed and load-tested it, and debugged its genuine failures with a ladder
and a 5-Whys discipline instead of luck. Concretely, you can now say: "I deploy versioned
images to a Kubernetes cluster, wire stable DNS between services, scale and roll back workloads,
capture and read the events that explain a broken pod, and take that same mental model to real
AWS EKS/ECR." That is not a talking point. It is a list of commands you have run.
