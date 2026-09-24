---
layout: module
title: "Module 09: Observability & Load Testing"
slug: 09-observability-load-testing
meta:
  part: Part IV — Operations
  subtitle: Logs, metrics-server, kubectl top, and the Locust load generator
---

# Module 09: Observability & Load Testing

## Learning Objectives

By the end of this module you will be able to:

- Name the three pillars of observability (logs, metrics, traces) and explain which two this
  course exercises and why traces are out of scope.
- Read application logs from any pod with `kubectl logs`, including selector-based, follow,
  tail, and multi-container variants.
- Use k3s's `metrics-server` and `kubectl top nodes` / `kubectl top pods` to watch resource
  usage, and interpret the numbers.
- Explain how readiness and liveness probes surface as observable events (recap of Module 02).
- Understand what Locust is, how the `loadgenerator` pod runs two containers, and how to read
  its stats table.
- Run a controlled failure-ripple drill (scale a backend to zero, watch the shop degrade,
  restore) without leaving the cluster in a broken state.

## Prerequisites

- Module 02 (probes, Deployments/ReplicaSets, `kubectl rollout status`).
- Module 04 (the loadgenerator service and its init container).
- Module 05 (services and the `frontend` -> backend call paths).

## Time estimate

Reading: 45 min · Hands-on: 60 min

## Concepts

### The three pillars: logs, metrics, traces

Production debugging answers three questions, and each has a dedicated tool family
collectively called the *three pillars of observability*:

- **Logs** are event records with a timestamp, emitted by code ("request started", "cart
  updated"). Great for reading what happened on one component; noisy at scale.
- **Metrics** are numeric snapshots over time (CPU-seconds, memory bytes, request counts).
  Great for trends and capacity; they tell you a symptom, not the story behind it.
- **Traces** reconstruct a single request's path across many services (service A called B,
  which called C, taking 40 ms). Great for distributed latency hunting; every service must
  cooperate by propagating a trace ID.

This course exercises logs and metrics end to end against the cluster. Traces are a
production-cloud specialty (OpenTelemetry, Jaeger, X-Ray) and are intentionally out of scope
here -- the shop never ships a trace header, and the tools we run do not record spans. Keep
the three-pillar vocabulary in mind anyway: when you interview for internships, "logs vs
metrics vs traces" is the standard framing.

### Logs with `kubectl logs`

Kubernetes gives you log access without ever SSHing into a node. The object you query is the
pod, and the runtime (here k3s's containerd) serves each container's stdout/stderr. The basic
form is:

```
kubectl logs [-n namespace] [-l label] [--tail=N] [-f] [-c container] POD
```

Flag by flag:

- `-n online-boutique` -- namespace of the pod.
- `-l app=loadgenerator` -- a *selector*. Instead of typing a pod name (which changes every
  time the pod is recreated), select by a label expression in the manifest. This is the
  same `-l` syntax you already use with `kubectl get pods`.
- `--tail=N` -- only the last N lines. Logs can be megabytes; almost always start here.
- `-f` -- follow: print new lines as they arrive, like `tail -f`. Kill it with Ctrl-C.
- `-c <container>` -- pick one container when the pod runs several (see below).

Real example 1: the load generator's live console. Because the loadgen pod has two containers,
kubectl tells you which it defaulted to:

```bash
kubectl logs -n online-boutique -l app=loadgenerator --tail=15
# Defaulted container "main" out of: main, frontend-check (init)
```

The `main` container runs Locust and prints its stats table every few seconds (reading it is
the subject of the Load testing section).

Real example 2: the cartservice, a .NET workload. On a fresh container the tail shows the
framework's own startup banner, then application logs:

```bash
kubectl logs -n online-boutique <cartservice-pod> --tail=15
# info: Microsoft.Hosting.Lifetime[14]
#       Now listening on: http://[::]:7070
# info: Microsoft.Hosting.Lifetime[0]
#       Application started. Press Ctrl+C to shut down.
```

"Now listening on: http://[::]:7070" tells you the HTTP server opened port 7070 on all
interfaces (`[::]` is IPv6 short for "any address"), which matters because `cartservice`'s
ClusterIP service exposes 7070/TCP to the other pods. After startup the same service logs its
real traffic: `AddItemAsync called with userId=..., productId=..., quantity=...`,
`GetCartAsync called with userId=...`, and `Checking CartService Health` -- these lines are
your direct evidence that frontend traffic is reaching the cart backend.

Real example 3: the loadgen's **init container**. `kubectl logs` can target the initialization
container by name:

```bash
kubectl logs -n online-boutique <loadgen-pod> -c frontend-check
# + MAX_RETRIES=12
# + RETRY_INTERVAL=10
# Attempt 1: Pinging frontend: frontend:80...
# + STATUSCODE=200
# + echo 'Frontend is reachable.'
# Frontend is reachable.
```

The init container's only job is to block until `http://frontend:80` answers HTTP 200, so the
main Locust process never hammers a not-ready shop. This is Module 02's *init container*
pattern in the wild.

Ordering trick: messages on stderr (like .NET's logging framework and Locust's stats, both on
stderr by convention) and stdout are interleaved by the runtime; if output ever looks out of
order, remember the two streams are merged, not the same order as your terminal happened to
capture them.

### Log formats: text vs structured

The cartservice prints human-readable text. The frontend (Go, uses stdout logging) prints
**structured logs**, one JSON object per line:

```json
{"http.req.id":"757efab4-...","http.req.method":"GET","http.req.path":"/product/2ZYFJ3GM2N",
 "http.resp.bytes":7963,"http.resp.status":200,"http.resp.took_ms":15,
 "message":"request complete","severity":"debug", ...}
```

Structured logs are parseable: pipeline them with `jq` to filter on `http.resp.status` or
`http.resp.took_ms` instead of eyeballing prose. This is why production systems mandate
structured logging; you now have a live example in your own cluster:

```bash
kubectl logs -n online-boutique -l app=frontend | \
  jq -r 'select(.http.resp.status and .http.resp.status != 200) | .message'
```

### Metrics with metrics-server and `kubectl top`

k3s ships a *metrics-server* controller that periodically scrapes each node's kubelet summary
API (the same low-level endpoint exposes per-container CPU and memory), and `kubectl top`
renders it as live tables. No full monitoring stack is installed: no Prometheus, no Grafana,
no Dashboards. That is deliberate -- `kubectl top` is the zero-config way to answer "is the
node melting?" and you can bolt on `Prometheus` (a metrics database + query language) plus a
dashboard later when you really need alerting and history.

```bash
kubectl top nodes
```

Real output on this course's single arm64 node:

```
NAME           CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)
64ee2f523cd3   173m         2%       840Mi           10%
```

`CPU(cores)` is accumulated CPU-seconds (the whole cluster has used 173 CPU-minutes since
boot); the percents are instantaneous. Twelve running services add up to well under one core
most of the time -- the load generator is the only service producing continuous request load.

```bash
kubectl top pods -n online-boutique | sort -k2 -h
```

`-k2 -h` sorts the second column (CPU) as human-readable numbers, so the busiest pods top out:

```
NAME                                     CPU(cores)   MEMORY(bytes)
frontend-cc489964d-vrrds                 10m          61Mi
loadgenerator-56ffb9946-95l4q            9m           64Mi
recommendationservice-55d9547b54-6vrf7   7m           54Mi
cartservice-7cb9f48559-tjnw9             3m           53Mi
...
```

Facts worth noting: `frontend` accrues CPU because it is the single entry point for every
shopper request; `loadgenerator` burns CPU running the synthetic users; memory is the resident
set in MiB and stays modest. Exact numbers drift between runs -- the lesson is relative ordering
and the magnitude, not the digits.

### Probes as operational signals (recap from Module 02)

The shop's manifests define two probes per service:

- *Readiness* gates traffic: k3s keeps a pod's READINESS GATE unmet until the probe succeeds,
  so the Service only routes to healthy replicas. For example the cartservice readiness probe
  connects to `10.42.0.x:7070`, and the frontend readiness probe does
  `GET http://...:8080/_healthz`.
- *Liveness* restarts the container: if the liveness probe stops succeeding, k3s restarts the
  container automatically.

These probes are also observability signals. k3s surfaces probe failures as events, e.g.:

```
Warning  Unhealthy   pod/cartservice-...   Readiness probe failed: timeout: failed to connect
                                            service "10.42.0.32:7070" within 1s
Warning  Unhealthy   pod/frontend-...      Liveness probe failed: Get
                                            "http://10.42.0.23:8080/_healthz": context deadline exceeded
```

You saw these exact messages in the cluster when the node was briefly resource-starved. Probe
failures are frequently an early symptom of a dependency being down -- which is the point of
the failure-ripple drill.

### Load testing with Locust

*Locust* is a Python load-testing tool: you describe user behavior as ordinary Python code,
and Locust spawns thousands of concurrent simulated users ("shoppers") who execute that
behavior and report per-endpoint statistics. It is a standard choice because writing a load
test is writing code, not clicking a GUI.

In this project the upstream `loadgenerator` image runs Locust against `http://frontend:80`.
The pod is two containers:

1. An *init container* named `frontend-check` (seen above) that polls the frontend until it
   returns HTTP 200, then exits `0` so the main container is allowed to start.
2. The `main` container running the Locust process that hammers the shop with browse, add-to-
   cart, and checkout requests.

The output that matters is the periodic stats table, one line per request `Type Name` plus an
`Aggregated` row. Real columns in order: `Name`, `# reqs`, `# fails`, then `Avg Min Max Med`
response times in ms, then `req/s` and `failures/s`:

```
Type     Name            # reqs   # fails        |  Avg  Min  Max  Med  |  req/s   failures/s
GET      /                 490     0(0.00%)      |   18    9   81   15   |   0.00    0.00
GET      /cart            1357     0(0.00%)      |    9    4  150    8   |   0.50    0.00
POST     /cart            1370     0(0.00%)      |   10    5  136    9   |   0.30    0.00
POST     /cart/checkout     444     1(0.23%)      |   16    6  324   14   |   0.10    0.00
--------|---------|----------|----------|--------|------|------|-------|--------|----------
         Aggregated       10508     1(0.01%)      |   10    4  324    8   |   2.50    0.00
```

How to read it:

- `# reqs` counts requests completed since Locust started for that endpoint; `# fails` counts
  HTTP/connect errors, with the error percentage in parentheses.
- `50th/95th percentile` thinking: `Med` is the median latency, and `Max` tells you the
  worst observed request, but a truer "load" story comes from the 50th/95th percentiles in
  the full Locust web UI. One slow outlier should not be described by "average".
- The `Aggregated` row is the whole-shop health line: total requests, total failures, and
  overall median. A healthy shop shows a tiny error rate. Across the runs in this course the
  aggregate was on the order of several thousand to ten thousand requests with 0.00-0.02%
  errors (one observed good run: 10,508 requests, 1 failure, 0.01%; earlier runs around 4,700
  requests at 0.01-0.02%, with a single transient checkout timeout every so often). Small,
  non-zero failure percentages happen under load and are not a bug by themselves; what matters
  is whether the rate jumps suddenly -- you will make it jump in the lab.

### Observing failure ripple

The shop is a chain: frontend -> (productcatalogservice, cartservice -> redis-cart, ...).
Kill one link and the leaf symptoms cascade upstream. The safe, classroom-approved way to
watch this is to scale a Deployment to zero replicas, watch, and then scale it back:

```bash
kubectl scale deploy cartservice -n online-boutique --replicas=0   # take it down
# ...observe...
kubectl scale deploy cartservice -n online-boutique --replicas=1   # restore
kubectl rollout status deployment.apps/cartservice -n online-boutique
```

While cartservice is down, `frontend` still serves product pages (they never touch the cart),
but everything cart-related fails: `GET /cart`, `POST /cart`, `POST /cart/checkout` start
accumulating failures because the frontend's calls to the `cartservice` ClusterIP service time
out. This is failure *ripple*: one broken microservice degrades a whole user journey while
leaving unrelated journeys healthy -- precisely the argument for the microservice layout, and
precisely the failure mode you must practice restoring before you can call yourself an operator.

The rule: **restore before you move on**, and prove it with `kubectl rollout status` printing
a successful rollout and a `READY 1/1` pod.

## Hands-On Lab

Start from a running shop (deployed in Module 04). These are the exact real commands.

```bash
# 1. Node-level resource pulse
kubectl top nodes
```

Expect one line for the course node: accumulated `CPU(cores)` growing, low `CPU(%)`, and a
couple hundred MiB of resident memory for all twelve pods.

```bash
# 2. Busiest pods first
kubectl top pods -n online-boutique | sort -k2 -h
```

Expect `frontend` and `loadgenerator` on top of the CPU column, with memory in the tens of MiB.
(If the table is empty, metrics-server may still be collecting its first samples; wait a minute
and re-run, and check `kubectl top nodes` first.)

```bash
# 3. Live shop traffic: the Locust console
kubectl logs -n online-boutique -l app=loadgenerator --tail=15
```

Observe the auto-selected `main` container and the stats table with an `Aggregated` row. Read
the failure column on `GET /cart` and `POST /cart/checkout`. Try Ctrl-C to stop following (no
`-f` used here, so the command simply returned the last 15 lines).

```bash
# 4. The init container that gates startup
kubectl get pods -n online-boutique -l app=loadgenerator -o name   # copy the pod name
kubectl logs -n online-boutique <pod-name> -c frontend-check
```

Observe `Attempt 1: Pinging frontend: frontend:80...` then `200` and `Frontend is reachable.`.

```bash
# 5. Backend under load: cartservice logs
kubectl logs -n online-boutique <cartservice-pod> --tail=15
```

You will see `AddItemAsync called with userId=..., productId=..., quantity=...` lines --
frontend traffic landing on the cart service, in real time. On a freshly restarted cartservice
the tail instead shows the .NET banner: `Now listening on: http://[::]:7070` then
`Application started.`.

```bash
# 6. Events tell stories: the rolling cluster event log
kubectl get events -n online-boutique --sort-by=.lastTimestamp | tail
```

The event log is bounded (old entries age out), so timing matters. During the initial deploy
you would have seen the k3s ServiceLB controller's `EnsuringLoadBalancer` entries for
`frontend-external`; during scale actions the controller emits `ScalingReplicaSet`-family
events; right now you are more likely to see `Scheduled` ("Successfully assigned
pod/... to <node>"), `Pulled`/`Created` when images are fetched, and `Warning Unhealthy`
probe events. If the window is empty, do the drill below first, then re-run -- a scale action
is guaranteed to write new events.

```bash
# 7. THE drill: failure ripple, with mandatory restore
kubectl scale deploy cartservice -n online-boutique --replicas=0
#         -> deployment.apps/cartservice scaled
```

Wait about twenty seconds, then read the Locust console again:

```bash
kubectl logs -n online-boutique -l app=loadgenerator --tail=12
```

Observe the ripple: `GET /cart` and `POST /cart` lines now show failures and
`Aggregated` has jumped from 1 failure to dozens (one observed run: 53 of 10,790 requests, 0.49%),
while `GET /product/...` page loads stay green. Product browsing works; the cart journey is
broken. `kubectl get pods -n online-boutique -l app=cartservice` shows no pod at all.

**Restore immediately**, then prove it:

```bash
kubectl scale deploy cartservice -n online-boutique --replicas=1
kubectl rollout status deployment.apps/cartservice -n online-boutique
# -> Waiting for deployment "cartservice" rollout to finish: 0 of 1 updated replicas are available...
# -> deployment "cartservice" successfully rolled out
kubectl get pods -n online-boutique -l app=cartservice -o wide   # READY 1/1 Running
```

Verify the Locust table returns to a low error rate. If the loadgen pod was restarted during
the gridlock, its counters may have reset -- that is fine; the error rate is what matters.

Optional: repeat step 6 after the scale-up and see the scale events for cartservice in the
event log. (The port-forward + curl access flow from Module 05 remains your reachability check:
`kubectl port-forward -n online-boutique svc/frontend-external 8080:80`, then
`curl http://localhost:8080`.)

## Common Pitfalls

- **`kubectl top` empty.** metrics-server needs a minute of collection after node start;
  check `kubectl top nodes` first, and if it is blank, wait and re-run rather than debugging
  the cluster.
- **Forgetting the second half of the drill.** Every `--replicas=0` must be matched with a
  `--replicas=1` plus a `kubectl rollout status` + `kubectl get pods` check. Leaving a service
  scaled to zero is the single easiest way to break the next lab.
- **Reading only the last line of the Locust table.** The `Aggregated` row is the headline,
  but the per-endpoint lines are the diagnosis: which method/path failed, and the failures
  column shows the percentage. Always look at both.
- **Using an old pod name.** Pod names embed a random suffix and change on every recreation.
  Query orchestrator state (`-l app=...`) and copy the current name instead of retyping it.
- **Misnaming a multi-container pod's containers.** The loadgen's containers are `main` and
  `frontend-check`; `kubectl logs ... -c <deployment-name>` fails with
  `container <name> is not valid for pod ...`. Use `kubectl logs` without `-c` to see the
  "Defaulted container" hint.
- **Interpreting probe-failure events as application crashes.** An `Unhealthy` Probe event
  means the probe timed out; the pod may be fine and the *dependency* slow (see the ripple
  drill). Check both ends before restarting anything.

## Key Takeaways

- Observability is logs + metrics + traces; this course runs logs and metrics with `kubectl`,
  and traces stay out of scope.
- `kubectl logs` is your universal pager: selectors, `--tail`, `-f`, and `-c` for
  multi-container pods cover almost every log need; frontends emit structured JSON, backends
  plain text.
- k3s's metrics-server turns kubelet summaries into `kubectl top nodes` / `kubectl top pods`
  with zero extra install; Prometheus is the graduate move when you need history and alerts.
- Probe failures surface as k3s events and are usually dependency symptoms, not the pod's own
  fault.
- Locust's per-endpoint table exposes exactly which dependency the broken service hurts; a
  healthy shop sits at a fraction of a percent aggregate error.
- The scale-to-zero drill proves the microservice failure model (one dead service, partial
  degradation) and drills the operator discipline of restoring and verifying state.

## Review Questions

1. Name the three pillars of observability and the single sentence that distinguishes each.
2. Why would you write `kubectl logs -n online-boutique -l app=loadgenerator` instead of
   `kubectl logs -n online-boutique <pod-name>`? What extra piece of state does the selector
   avoid needing to know?
3. What does `kubectl top pods -n online-boutique | sort -k2 -h` do, and which pod do you
   expect at the top of the CPU column and why?
4. A service's readiness probe fails but the process is running. What two k3s signals confirm
   this, and what is the most likely actual cause in a scale-to-zero drill?
5. You see `Aggregated 10508 1(0.01%) [ ... ]` in the Locust console. Interpret every field
   of that row in one sentence.
6. The drill says to scale cartservice to zero, watch, then restore. List the exact restore
   sequence and the three checks that prove the shop is healthy again.

### Answers

1. Logs are timestamped event records; metrics are numeric snapshots over time; traces
   reconstruct one request's path across all services. This course uses logs + metrics;
   traces require distributed trace IDs and are out of scope here.
2. The selector names a class of pods, so you never need the current random pod suffix --
   pod names change on every recreation. The extra state you avoid is the pod name; the
   selector needs only the label used in the manifest.
3. It prints per-pod CPU/memory and sorts numerically by the second (CPU) column, busiest
   first. `frontend` tops the CPU column because every shopper request enters through it, and
   `loadgenerator` is a close second because it generates the load.
4. k3s emits `Warning Unhealthy` events with `Readiness probe failed: timeout: ... within 1s`
   messages while the pod stays `Running`. Since the process is alive, the cause is usually a
   missing or slow dependency (here: cartservice scaled to zero, so the frontend's cart
   calls exceed the 1 s probe timeout).
5. Since Locust started, it completed 10,508 total requests with 1 failure (0.01%); overall
   median latency 10 ms, min 4 ms, max 324 ms, and current throughput 2.5 requests/second.
6. `kubectl scale deploy cartservice -n online-boutique --replicas=1`, then
   `kubectl rollout status deployment.apps/cartservice -n online-boutique` must print
   "successfully rolled out", `kubectl get pods -n online-boutique -l app=cartservice -o wide`
   must show `READY 1/1 Running`, and the loadgenerator's `Aggregated` row must return to a
   near-zero error rate.