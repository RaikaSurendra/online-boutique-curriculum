---
layout: module
title: "Module 02: Kubernetes Core"
slug: 02-kubernetes-core
meta:
  part: Part I — Foundations
  subtitle: Architecture, Pods, Deployments, probes, init containers, resources
---

# Module 02: Kubernetes Core

Module 01 showed you how to package an application as an immutable Docker image and run it on one
host. Real systems have many machines, many copies of many apps, and a constant need to recover
from crashes, roll out new versions, and balance load. Kubernetes automates all of that. This module
builds the mental model needed to read the Online Boutique manifest
(`onlineBoutique/manifests/kubernetes-manifests.yaml`, 980 lines, 12 Deployments) and understand
what is happening on the Floci EKS `dev-cluster`.

## Learning Objectives

By the end of this module, you will be able to:

- Understand the problem Kubernetes solves (declarative desired state, self-healing, scheduling)
  and who builds what: control plane vs. data plane, plus how k3s collapses the control plane into
  one binary in the `floci-eks-dev-cluster` container.
- Read an object's `metadata`, `spec`, and `status` and predict what `kubectl apply` does with it.
- Distinguish Pod, ReplicaSet, Deployment, Namespace, and ServiceAccount, and pick the right one
  for a job.
- Explain the reconciliation loop in terms of observed vs. desired state, and when
  `kubectl get` vs. `kubectl rollout status` answers "is it done?"
- Interpret the real probes, init containers, resource requests, and `imagePullPolicy` settings.

## Prerequisites

- Module 01 (`../01-docker-containers.md`): images and containers, Dockerfile basics, image tags,
  arm64 vs amd64.
- Working `kubectl` access to `dev-cluster` (k3s v1.34.1+k3s1, single arm64 node) with the
  `online-boutique` namespace deployed (course README).

## Time Estimate

Reading: 90 min · Hands-on: 60 min

## Concepts

### What Kubernetes Is, and What It Solves

*Kubernetes* is an open-source container orchestration platform. "Orchestration" means three jobs:

1. **Declarative desired state.** You never say "start pod X"; you declare the end state
   (`replicas: 1`, image `.../frontend:v0.10.7`) and Kubernetes figures out the steps to make
   reality match. Your file is a contract, not a script.
2. **Self-healing.** If a container dies or a node vanishes, Kubernetes notices reality no longer
   matches the declaration and repairs it with no human.
3. **Scheduling.** With multiple nodes, Kubernetes decides where each workload runs, balancing
   CPU/memory, labels, and constraints.

Container runtimes solved packaging and isolation; orchestrators solve *operating* containers at
scale — rollout, rollback, recovery, load balancing, and configuration, all driven by declared
intent.

### Cluster Architecture: Control Plane and Data Plane

Every Kubernetes cluster has two halves: the **control plane** ("brain") decides what should run,
where, and what is unhealthy; the **data plane** ("muscle") runs your containers on the nodes.

```
  kubectl apply -f manifest.yaml
              |
              v
+------------------------------------------------------------------+
|                    CONTROL PLANE                                  |
|   floci-eks-dev-cluster  (k3s: one binary, one container)        |
|                                                                  |
|      kube-apiserver  <-----------  etcd (state store)            |
|          |   ^                                                   |
|          |   | watch/events                                      |
|          v   |                                                   |
|  kube-controller-manager          kube-scheduler                |
+------------------------------------------------------------------+
              |  kubelet API (pod assignments)
              v
+------------------------------------------------------------------+
|                     DATA PLANE  (the node)                       |
|   kubelet -> container runtime (containerd) -> pods/containers   |
|   kube-proxy -> service traffic rules (iptables/ipvs)            |
+------------------------------------------------------------------+
```

The canonical EKS control plane:

- **kube-apiserver** — the single control point. Every interaction (every `kubectl`, every
  controller) goes through it over HTTPS; it is the only component that talks to etcd, and it
  validates and persists every object.
- **etcd** — a distributed key/value store holding all cluster state (every object, version, and
  observed status); the source of truth.
- **kube-scheduler** — assigns unplaced Pods to nodes whose allocatable CPU/memory and labels
  satisfy the Pod's requests.
- **kube-controller-manager** — runs the controller loops (Deployment, ReplicaSet, namespace, ...)
  that keep reality converging on desired state.

The data plane on every node:

- **kubelet** — the node agent; receives pod assignments, tells the container runtime what to
  create, runs the probes, and reports status back.
- **kube-proxy** — maintains the network rules that implement Services (usually iptables).
- **container runtime** — creates containers from images; the modern default is **containerd**
  (used by EKS and k3s).

**How k3s (and therefore Floci's EKS) differs.** Amazon EKS runs the control plane on separate
managed machines. Floci emulates EKS *using k3s in a single Docker container* named
`floci-eks-dev-cluster`. k3s bundles kube-apiserver, an embedded datastore (SQLite by default on a
single node; embedded etcd in HA mode), the scheduler, the controller manager, the kubelet,
kube-proxy, and containerd into one small binary — so the whole control plane is one process tree
inside one container. That is why `docker exec floci-eks-dev-cluster kubectl get nodes` works as a
debugging move (`eksSetup/Error_Documentation.md`), and why that container is wired into the
`floci-net` Docker network next to the Floci ECR registry sidecar.

### The Object Model: metadata, spec, and status

Everything Kubernetes manages is an *object*, and every object has the same three-part shape:

```yaml
apiVersion: apps/v1      # which API group and version
kind: Deployment         # the type of object
metadata:                # identity and bookkeeping
  name: frontend
  namespace: online-boutique
  labels:
    app: frontend
spec:                    # DESIRED STATE - what you want
  replicas: 1
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
      - name: server
        image: 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7
status:                  # OBSERVED STATE - written by controllers, not by you
  readyReplicas: 1
  availableReplicas: 1
```

The rule to remember: **you write `spec`, Kubernetes writes `status`.** Setting `status` in a file
is rejected; `spec` is the desire, `status` is the truth.

`kubectl apply -f manifest.yaml`: `kubectl` merges your file with its last-applied view of the
object and POSTs JSON to the kube-apiserver, which authenticates you (via the `floci-eks` profile +
token webhook, Module 07), authorizes, validates against the schema, default-fills missing fields,
and writes the object to etcd. The object now exists but nothing has run yet; controllers watching
the API server see it and begin converging reality toward `spec`.

### Core Workload Objects

#### Pod

A **Pod** is the smallest deployable unit — the scheduling unit. It wraps one or more containers
sharing one network namespace (one IP, shared ports and `localhost`) and any shared volumes. In
Online Boutique every Pod runs one application container (`server` or `main`), plus, for the
loadgenerator, an init container.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sample-pod
  namespace: online-boutique
  labels:
    app: sample
spec:
  containers:
  - name: hello
    image: busybox:1.38.0
    command: ["/bin/sh", "-c", "echo hello && sleep 3600"]
```

Bare Pods are rarely used in production: machines reboot and Pods are disposable. The objects below
give Pods their immortality.

#### ReplicaSet

A **ReplicaSet** guarantees a *desired number of identical Pods*. Its two key fields are
**`replicas`** (how many copies) and **`selector`** — a *label selector*, a query over labels
(`app: frontend` is a label; `matchLabels: { app: frontend }` is the query) deciding which Pods the
ReplicaSet owns.

```yaml
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: frontend-6c9d9f6b7d
  namespace: online-boutique
spec:
  replicas: 1
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
      - name: server
        image: 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7
```

The `template` is the Pod blueprint. The ReplicaSet loop: count Pods matching the selector, then
create or delete until the count equals `replicas`. Template labels and selector must match or it
can never find its own Pods.

#### Deployment

A **Deployment** is the production object: it *manages* ReplicaSets, and its template-change history
gives you **rollouts, revisions, and rollbacks**. Change the Pod template (new image tag, new env
var) and the Deployment creates a brand new ReplicaSet and migrates Pods from old to new. Each
ReplicaSet is a **revision** (`kubectl rollout history deployment/frontend`); prior ones are
retained, so `kubectl rollout undo deployment/frontend` reinstates the last good revision.

Migration is a **rolling update** bounded by two knobs: **`maxSurge`** — extra Pods allowed *above*
desired during the update (default `25%`; with one replica, one extra Pod is created first,
preserving capacity) — and **`maxUnavailable`** — Pods allowed *below* desired during the update
(default `25%`). A Pod only counts once its readiness probe passes, so a bad new version stalls the
rollout instead of taking the shop down. You never manage ReplicaSets by hand; the Deployment owns
them.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: online-boutique
  labels:
    app: frontend
spec:
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      serviceAccountName: frontend
      containers:
      - name: server
        image: 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7
        ports:
        - containerPort: 8080
```

#### Namespace

A **Namespace** logically partitions a cluster: object names are scoped per namespace, as are access
control and resource quotas. The shop lives in `online-boutique`, which is why nearly every command
in this course needs `-n online-boutique`; otherwise the API server assumes `default`.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: online-boutique
```

#### ServiceAccount

A **ServiceAccount** is the *identity a Pod runs as*. Every Pod has one — unset, it silently gets
the namespace's `default` ServiceAccount. ServiceAccounts let a Pod authenticate to the API server
or external systems without human credentials.

The manifest is explicit: every Deployment sets `serviceAccountName: <service>`, and the manifest
defines **11 ServiceAccounts** — one per service (`frontend`, `adservice`, `cartservice`,
`checkoutservice`, `currencyservice`, `emailservice`, `loadgenerator`, `paymentservice`,
`productcatalogservice`, `recommendationservice`, `shippingservice`). There are 12 Deployments;
`redis-cart` is the odd one out and runs as the default ServiceAccount.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: frontend
```

### Controllers and Reconciliation

The heart of Kubernetes is a **control loop** borrowed from control theory:

```
   DESIRED (spec)          OBSERVED (status/reality)          ACTION
   replicas: 1       --vs--> 0 ready pods running      --> create one pod
   replicas: 1       --vs--> 2 ready pods running      --> delete one pod
   replicas: 1       --vs--> 1 ready pod running       --> do nothing
```

Every controller loops forever: **observe** current cluster state through the API server's watch
stream (`status`), **compare** against desired state (`spec`), **act** to close the gap, repeat.
Any external perturbation (killed container, deleted Pod) is just a new observation that differs
from `spec` — which is exactly why the system self-heals. The layering matters: the Deployment
controller reconciles Deployments against ReplicaSets; the ReplicaSet controller reconciles
ReplicaSets against Pods. A version bump fans out as: Deployment creates a ReplicaSet; the scheduler
places its Pods; kubelets start the containers.

Two commands give two views of "is it done?": `kubectl get` reads **status** at one instant (ready
replicas, Pod phase, node placement); `kubectl rollout status` *waits* for convergence, polling
until all updated Pods are available. `scripts/04-deploy.sh` loops
`kubectl rollout status <deploy> --timeout=5m` over every Deployment before declaring the deploy
done.

### Probes: Liveness and Readiness

A **probe** is a health check the kubelet runs against a container. **readinessProbe** answers "can
this container receive traffic?" — on failure the Pod is marked not-ready and removed from its
Service's endpoints, but it is **not** restarted; it gates *traffic*. **livenessProbe** answers "is
this container alive?" — on failure the kubelet **restarts** the container (repeated failures ->
`CrashLoopBackOff`); it gates *life*.

The real frontend Deployment checks both against the Go app's HTTP health endpoint:

```yaml
readinessProbe:
  initialDelaySeconds: 10
  httpGet:
    path: "/_healthz"
    port: 8080
    httpHeaders:
    - name: "Cookie"
      value: "shop_session-id=x-readiness-probe"
livenessProbe:
  initialDelaySeconds: 10
  httpGet:
    path: "/_healthz"
    port: 8080
    httpHeaders:
    - name: "Cookie"
      value: "shop_session-id=x-liveness-probe"
```

- `httpGet` `/_healthz` on container port `8080` is the right check for plain HTTP; the gRPC-only
  services instead use `grpc` probes, which is all that makes sense for an RPC-only process.
- `initialDelaySeconds: 10` lets the binary start before probing; the unset `periodSeconds` and
  `failureThreshold` default to probing every **10s** with **3** failures allowed before acting.
- The `Cookie` header makes the check look like a real session (this app keys state on the
  `shop_session-id` cookie).
- For a web frontend whose home page renders live downstream data, readiness decides *when traffic
  is safe* (it gates every rollout: a Pod only joins the Service's endpoints once `/_healthz`
  passes); liveness recycles a dead-locked process instead of letting it sit forever.

### Init Containers

An **init container** runs to *completion, in order, before the main containers start*. A non-zero
exit fails the Pod, and Kubernetes retries from the beginning per the restart policy. Init
containers share the Pod's volumes and network.

Online Boutique uses exactly one. The `loadgenerator` Deployment defines a `busybox` init container
named **`frontend-check`** that runs before the main Locust container:

```yaml
initContainers:
- name: frontend-check
  image: busybox:1.38.0@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616
  env:
  - name: FRONTEND_ADDR
    value: "frontend:80"
  command:
  - /bin/sh
  - -exc
  - |
    MAX_RETRIES=12
    RETRY_INTERVAL=10
    for i in $(seq 1 $MAX_RETRIES); do
      echo "Attempt $i: Pinging frontend: ${FRONTEND_ADDR}..."
      STATUSCODE=$(wget --server-response http://${FRONTEND_ADDR} 2>&1 | awk '/^  HTTP/{print $2}')
      if [ $STATUSCODE -eq 200 ]; then
          echo "Frontend is reachable."
          exit 0
      fi
      echo "Error: Could not reach frontend - Status code: ${STATUSCODE}"
      sleep $RETRY_INTERVAL
    done
    echo "Failed to reach frontend after $MAX_RETRIES attempts."
    exit 1
```

Up to 12 times, every 10 seconds, it fetches `http://frontend:80` and requires HTTP `200`; the main
Locust container starts only after that. This is an *availability gate*: the load generator must
not begin synthetic shopping against a frontend that is not serving, because that would seed the
Module 09 metrics with false failures. Slow frontend? It retries. Frontend down? It exits non-zero,
the Pod restarts, and init runs again — patiently waiting out recovery.

### Resource Requests and Limits

Kubernetes does not guess resource needs; you declare them, and the two numbers drive different
mechanisms:

- **requests** — what is *reserved* and guaranteed to this container. The **scheduler** uses
  requests for placement: a Pod sits only on a node whose allocatable capacity (minus other
  requests) still has room. Requests govern *scheduling and reservation*.
- **limits** — the *ceiling* enforced on the running container: exceeding a CPU limit throttles,
  exceeding a memory limit OOM-kills. Limits govern *enforcement*.

The real frontend block:

```yaml
resources:
  requests:
    cpu: 100m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 128Mi
```

Units you must read: **CPU** is cores with millicore fractions (`100m` = `0.1` core, `200m` = `0.2`).
**Memory** is bytes with `Mi` = mebibytes (`64Mi` = `64 * 2^20` bytes); the manifest uses binary
`Mi`, not SI `M`.

The scheduler compares requests against node allocatable capacity (see `kubectl describe node`);
the 12 Deployments total ~1.5 CPU / ~1.3 GB of requests. Requests too low -> the node is overbooked
and containers starve. Requests too high -> Pods stay `Pending` because no node fits.

**QoS (Quality of Service) classes** decide which containers the kernel sacrifices first under
memory pressure: **Guaranteed** (every container: requests == limits), **Burstable** (requests and
limits differ — the frontend's 100m/64Mi vs 200m/128Mi is **Burstable**), or **BestEffort** (no
requests or limits at all; least protected).

### imagePullPolicy: IfNotPresent

`imagePullPolicy` decides *when the node pulls an image*: `Always` (every start), `IfNotPresent`
(default whenever the tag is not `:latest`), or `Never` (local images only). The Online Boutique
manifest sets no policy, and because every image uses an explicit tag (`:v0.10.7`, `:1.38.0`), the
effective policy is **`IfNotPresent`**: the k3s node reuses images already cached in containerd.

This is convenient but has an edge case: **tags are mutable**. Push a new image under the same tag
(say, a fixed arm64 cartservice) and the node silently keeps the stale cached digest.
`03-build-push-images.sh` works around it by evicting the cache after each push:

```bash
docker exec floci-eks-dev-cluster crictl rmi \
  "$ECR_REGISTRY/$ECR_REPO_PREFIX/$svc:$IMAGE_TAG" || true
```

Without that eviction, `IfNotPresent` serves the old image forever. This mechanism sits behind
several `ImagePullBackOff` and "why is my fix not applying" bugs in Modules 08 and 11, and it is
why production teams use immutable tags (digests, commit SHAs) or force `Always`.

## Hands-On Lab

Prereq: `online-boutique` is deployed to `dev-cluster`. These are the same commands wrapped by
`onlineBoutique/scripts/05-verify.sh`.

**1. Inspect namespaces and the shop's workload objects.**

```bash
kubectl get ns
kubectl get pods -n online-boutique
kubectl get deploy -n online-boutique
```

Expected (pod/deployment suffix hashes vary). `kubectl get ns` shows the cluster-wide namespaces;
`online-boutique` should be `Active` alongside `default`, `kube-system`, `kube-public`, and
`kube-node-lease`:

```text
$ kubectl get deploy -n online-boutique
NAME                    READY   UP-TO-DATE   AVAILABLE   AGE
adservice               1/1     1            1           8d
cartservice             1/1     1            1           8d
checkoutservice         1/1     1            1           8d
currencyservice         1/1     1            1           8d
emailservice            1/1     1            1           8d
frontend                1/1     1            1           8d
loadgenerator           1/1     1            1           8d
paymentservice          1/1     1            1           8d
productcatalogservice   1/1     1            1           8d
recommendationservice   1/1     1            1           8d
redis-cart              1/1     1            1           8d
shippingservice         1/1     1            1           8d

$ kubectl get pods -n online-boutique
NAME                                     READY   STATUS    RESTARTS   AGE
frontend-6c9d9f6b7d-l9tkb                1/1     Running   0          8d
cartservice-5476d5b984-vh2gm             1/1     Running   0          8d
productcatalogservice-5764c6d49b-hs3jd   1/1     Running   0          8d
# ... (9 more, one pod per Deployment)
```

Observe: 12 Deployments at 1 replica each, `READY 1/1` means readiness passes, and the pod-name
pattern is `<deployment>-<replicaset-hash>-<random>`.

**2. Inspect the real probe block on a frontend Pod.**

```bash
kubectl get pods -n online-boutique -l app=frontend -o name
# example: pod/frontend-6c9d9f6b7d-l9tkb
kubectl get pod frontend-6c9d9f6b7d-l9tkb -n online-boutique -o yaml | grep -A3 livenessProbe
```

Expected (the API server has defaulted unset fields):

```text
  livenessProbe:
    failureThreshold: 3
    httpGet:
      path: /_healthz
      port: 8080
    periodSeconds: 10
```

Use `grep -B2 -A7 readinessProbe` to see the readiness block (same path, its own cookie header).
Compare with `kubernetes-manifests.yaml`.

**3. Exercise a rolling update.**

```bash
kubectl rollout restart deployment/frontend -n online-boutique
kubectl rollout status deployment/frontend -n online-boutique
```

Expected:

```text
deployment.apps/frontend restarted
Waiting for deployment "frontend" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "frontend" rollout to finish: 0 of 1 updated replicas are available...
deployment "frontend" successfully rolled out
```

`rollout restart` force-changes the template (a restart annotation) so the Deployment builds a new
ReplicaSet and rolls through it exactly as an image upgrade would — same image, so you watch
mechanics without changing the app. Right after, run `kubectl get rs -n online-boutique`,
`kubectl rollout history deployment/frontend -n online-boutique`, then
`kubectl rollout undo deployment/frontend -n online-boutique` to roll back.

**4. Inspect the loadgenerator's init container.**

```bash
kubectl describe pod -n online-boutique -l app=loadgenerator
```

Expected excerpt (trimmed):

```text
Name:             loadgenerator-5d8764c8f9-vq4h8
Init Containers:
  frontend-check:
    Container ID:  containerd://a1b2...
    Image:         busybox:1.38.0@sha256:dc2d74b...
    State:         Terminated
      Reason:       Completed
      Exit Code:    0
    Ready:          True
    Environment:
      FRONTEND_ADDR:  frontend:80
Containers:
  main:
    Image:      000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/loadgenerator:v0.10.7
    State:      Running
```

Observe the `frontend-check` init container, its `Terminated / Completed / Exit Code 0` state, and
that the Pod reports Ready only with both init and main containers healthy — the ordering guarantee
made visible.

**5. Measure real resource usage.**

```bash
kubectl top pods -n online-boutique | sort -k2 -h
```

Expected (values vary with load; the loadgenerator burns the most CPU):

```text
NAME                                     CPU(cores)   MEMORY(bytes)
paymentservice-6d85cbd7b4-gg5qm          1m           14Mi
emailservice-7b8d6f9d4c-lm7xp            2m           25Mi
frontend-6c9d9f6b7d-l9tkb                4m           19Mi
...
loadgenerator-5d8764c8f9-vq4h8           280m         350Mi
```

`kubectl top` reads metrics-server, which **k3s ships by default**. In the first minute after
startup it may say `Metrics API not available` until the first collection cycle. `sort -k2 -h`
sorts the human CPU column so the top consumer shows last. Compare against the manifest: loadgenerator
requests 300m CPU / 256Mi and limits 500m / 512Mi — which is why ~280m runs without throttling and
the scheduler had room for it.

## Common Pitfalls

### Forgetting the namespace
Every command here needs `-n online-boutique`; without it you get `Error from server (NotFound)`
or, worse, inspect the wrong namespace. Always pass `-n`, as the project scripts do.

### Template labels vs. selector mismatch
If `selector.matchLabels` and `template.metadata.labels` differ, the API server rejects the
Deployment or the ReplicaSet can never see its Pods. Keep them identical; selectors are immutable.

### Editing `status` in YAML
`status` is owned by controllers; reapplying a `-o yaml` dump produces merge conflicts. Write
`spec` and let the controllers write `status`.

### Confusing readiness with liveness
Liveness on a slow-starting service causes restart loops; readiness-as-liveness lets dead-locked
containers sit forever. Use `initialDelaySeconds` to skip startup, as the frontend does with 10s.

### Hardcoding a pod name in scripts
Pod names embed the ReplicaSet hash and change after every rollout. Grep by label
(`-l app=frontend`) instead.

### Overcommitting requests / missing metrics-server
Requests above node allocatable leave Pods `Pending` forever (`kubectl get events` reports
`insufficient cpu`). And `kubectl top` needs metrics-server — managed EKS may require installing
it, but this course's k3s ships it, which is why `scripts/05-verify.sh` can call it at all.

### Relying on stale tags with IfNotPresent
Repushing `image:v0.10.7` does not change what `IfNotPresent` serves. Evict with `crictl rmi` (as
`03-build-push-images.sh` does) or switch to immutable tags/digests.

## Key Takeaways

- Kubernetes is declarative: you author `spec`, controllers converge `status` toward it, and the
  cluster repairs drift on its own.
- The API server is the single control point and the only component that persists to etcd; k3s packs
  the whole control plane into one binary inside `floci-eks-dev-cluster`, which is what Floci's EKS
  actually runs.
- Pods are disposable scheduling units; production workloads are Deployments, which manage
  ReplicaSets and give health-gated rolling updates, revisions, and rollbacks.
- Namespaces partition the cluster, ServiceAccounts give Pods identity, and labels + selectors glue
  objects together.
- Readiness gates traffic, liveness gates life, init containers gate startup order, and
  requests/limits gate scheduling and enforcement.
- This manifest's effective `imagePullPolicy` is `IfNotPresent`, and tag caching can serve stale
  images after a re-push.

## Review Questions

1. What three jobs does Kubernetes automate, and which one explains why a killed container comes
   back without a human?
2. Why is the kube-apiserver called "the single control point"? Which component does it alone talk
   to for persistence?
3. In the reconcile loop, what is meant by observed vs. desired state? Which Deployment fields does
   this map to?
4. The frontend runs one replica. During a rolling update a new ReplicaSet is created. What do
   `maxSurge` and `maxUnavailable` control, and what do their `25%` defaults mean here?
5. The frontend has liveness and readiness probes against `/_healthz:8080` with
   `initialDelaySeconds: 10`. What happens, respectively, when each starts failing?
6. Why must the loadgenerator's `frontend-check` init container see HTTP 200 at `frontend:80`
   before the main Locust container starts?
7. A Deployment requests `cpu: 100m`, limits `cpu: 200m`. What does each mean in real CPU terms,
   what QoS class results, and which one does the scheduler use?

### Answers

1. Declarative desired state, self-healing, and scheduling. Self-healing: a dead Pod is an observed
   deviation from `spec.replicas`, so the ReplicaSet controller recreates it.
2. Every client and controller communicates through it, and it is the only component that persists
   cluster state — all reads and writes go to etcd.
3. Observed state is what exists (the controller's `status`); desired state is the declaration
   (`spec`). The loop diffs the two and acts to close the gap.
4. `maxSurge` bounds extra Pods above desired during the update; `maxUnavailable` bounds the
   shortfall below desired. The `25%` defaults round up, so a one-replica Deployment may briefly run
   two Pods and never drop below one.
5. Liveness failure: kubelet restarts the container (repeated failures -> `CrashLoopBackOff`).
   Readiness failure: the Pod is marked not-ready and removed from the Service's endpoints; no
   restart.
6. It prevents a load test from starting against a frontend that is not serving, which would seed
   the metrics with false failures. The main container starts only after init exits 0.
7. `100m` = 0.1 core, `200m` = 0.2 cores. Requests differ from limits, so the Pod is **Burstable**.
   The scheduler uses **requests**; limits are runtime enforcement, not placement input.

*Next: Module 03 (`../03-microservices-architecture.md`) builds the architecture layer — why the
shop is split into 11 microservices and how they talk to each other.*
