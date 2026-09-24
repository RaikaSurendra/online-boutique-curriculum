---
layout: module
title: "Module 03: Microservices Architecture"
slug: 03-microservices-architecture
meta:
  part: Part I — Foundations
  subtitle: Monolith vs microservices, patterns, the Online Boutique topology
---

# Module 03: Microservices Architecture

Modules 01 and 02 taught you the container and Kubernetes substrate: images, Pods, Deployments,
probes, and the reconciliation loop. Now we zoom out to the *architecture* sitting on top of that
substrate. Online Boutique is not one application but a system of 11 cooperating services. This
module explains why anyone would build software that way, what the trade-offs are, how those
services talk to each other, and exactly how the dependency graph of the real deployment looks and
behaves.

## Learning Objectives

By the end of this module, you will be able to:

- Contrast monoliths and microservices, naming at least three advantages and three costs of each.
- List the core microservice design principles and map each one to a concrete Online Boutique
  artifact (service, port, contract, datastore).
- Distinguish synchronous (HTTP/gRPC) from asynchronous (messaging) communication and describe
  which one this project uses and why.
- Draw the Online Boutique call graph: everything the frontend calls, what checkout calls, and
  what cart calls, with real ports.
- Explain name-based service discovery (`productcatalogservice:3550`) as the addressing mechanism
  that replaces hardcoded IPs.
- Explain the failure-ripple lesson: a down backend makes the frontend home page return HTTP 500.
- Describe briefly what a service mesh is and how it changes service-to-service communication.

## Prerequisites

- Module 01 (`../01-docker-containers.md`) and Module 02 (`../02-kubernetes-core.md`): containers,
  Pods, Deployments, Services, probes, init containers.
- The `online-boutique` namespace deployed on `dev-cluster` (course README).

## Time Estimate

Reading: 90 min · Hands-on: 45 min

## Concepts

### Monoliths vs. Microservices

A **monolith** is an application built as a single deployable unit: all features (product listing,
cart, checkout, payment, email) ship as one codebase, one artifact, one process. Module boundaries
are enforced by discipline and code review, not by the runtime. To scale a monolith you run more
copies of the *whole* application; to change one feature you rebuild, retest, and redeploy *all* of
it.

A **microservice architecture** is an application decomposed into small, independently deployable
services, each owning one business capability and communicating over a network. "Micro" is about
the size of the *decision surface* (one capability, one team owns it) more than the number of lines
of code.

| Dimension | Monolith | Microservices |
|---|---|---|
| Scalability | Scale the whole app, even if one feature is hot | Scale each service independently (only cart needs more replicas) |
| Deployment | One artifact; one change redeploys everything | Each service deploys alone; per-service rollback |
| Tech freedom | One language, one framework stack | Each service can pick its best language/storage |
| Team autonomy | Shared repo, shared release train | Teams own services end to end |
| Complexity | Low at first (in-process calls, one DB) | High: distributed calls, partial failure, data consistency |
| Network | No network between features | Every call crosses a network boundary (latency, timeouts, failures) |
| Operations | One app to monitor, deploy, debug | N apps, N log streams, N health endpoints |

Reading the table top to bottom, microservices buy you *independence* and pay for it with
*distributed complexity*. Online Boutique makes that trade deliberately: it is a teaching
deployment of 12 Deployments precisely so you can see both the freedom (5 languages in one shop)
and the cost (each Dockerfile, each registry entry, each probe, each failure mode).

### Microservice Design Principles

Seven principles recur in every well-built microservice system; each maps directly onto Online
Boutique.

1. **Single responsibility.** Each service does exactly one business job. `productcatalogservice`
   owns product data; `cartservice` owns the cart; `paymentservice` charges cards. No service
   does another's job.
2. **Bounded contexts.** A *bounded context* is an explicit boundary around a business domain with
   its own terminology and its own data. The "product" as catalog data, the "product" as a cart
   line, and the "product" as a recommendation seed are three different models in three different
   services; they never share one class.
3. **Database per service.** Each service owns its data store and no one else reads it. In this
   project: the cart is the only consumer of `redis-cart` (Redis), the currency service owns its
   rates, the product catalog owns its SKU list. Shared tables are forbidden; they would silently
   recreate a monolith.
4. **API contracts.** A service's external behavior is defined by an interface, not by its internal
   implementation. gRPC services do this with `protobuf` `.proto` files — the `.proto` *is* the
   contract that both client and server compile against. Change the contract and every consumer
   must follow.
5. **Service discovery.** Callers must not hardcode IPs (which change as Pods churn). They call a
   stable name; the cluster resolves it at runtime. Module 02's `frontend:80` was one example; this
   project addresses everything by service name.
6. **Resilience.** Network calls fail in ways in-process calls cannot (timeouts, crashes, a
   half-dead dependency). Good systems add timeouts, retries, and circuit breakers, and gate work
   behind health checks. In this project the visibility of that principle is the
   `frontend-check` init container from Module 02: the load generator refuses to start until the
   frontend answers 200.
7. **Observability.** Distributed systems need logs, metrics, and health endpoints per service.
   Every service implements `/_healthz` or a gRPC health check, metrics-server reads node/pod
   usage, and the load generator produces a live latency/error report — all exercised in the lab
   below and in Module 09.

### Communication Patterns: Synchronous vs. Asynchronous

There are two fundamental ways for services to talk:

- **Synchronous (request/reply):** a caller sends a request and waits for a response. Typical
  transports: plain HTTP (human-ish, JSON) and **gRPC** — a strongly typed, binary RPC framework
  over HTTP/2 that serializes messages with **protobuf** and defines its interface in `.proto`
  files. Easy to reason about, but the caller's availability is tied to the callee's: if the
  callee is slow or down, the caller waits or errors.
- **Asynchronous (messaging):** a caller publishes an event or message to a broker (Kafka, RabbitMQ,
  Redis streams) and continues; one or more consumers process it later. Decouples availability and
  smooths bursts, at the cost of eventual consistency and new infrastructure to operate.

Online Boutique is **entirely synchronous**:

```
 browser  --HTTP------>  frontend
 frontend --gRPC----->  all backend services
```

- HTTP (port 8080, JSON) from the browser to the Go frontend.
- gRPC (protobuf) between essentially every backend pair: frontend -> productcatalog on :3550,
  checkout -> paymentservice on :50051, and so on. The service ports are the gRPC ports.

Nothing in this app is message-broker based. That single choice has a direct consequence you will
observe in "Failure Ripple" below: a synchronous dependency outage propagates instantly to every
caller up the chain, which is why resilience work (health gates, timeouts, rollouts that respect
readiness) matters so much.

### A Brief Word on Service Meshes

A **service mesh** inserts a sidecar proxy into every Pod; all service-to-service traffic passes
through the sidecars, which now control it centrally. Because the proxies sit on the data path they
can add, transparently to application code: mutual TLS (mTLS) between services, retries, timeouts,
circuit breakers, fine-grained traffic splitting (canary), and per-call metrics/tracing.

The Online Boutique manifest is mesh-aware without shipping one: the ingress-style annotations
`sidecar.istio.io/rewriteAppHTTPProbers: "true"` on the `frontend` and `loadgenerator` templates
tell an Istio sidecar to keep Kubernetes HTTP probes working. No mesh is deployed in the Floci
emulator — the default path is direct pod-to-pod networking — so the mesh stays a "what if" gotcha
for this course, relevant if you later add Linkerd/Istio to a real cluster.

### The Online Boutique Topology

Behind the browser sits a web frontend that fans out to seven backend services; checkout fans out
to four more; the cart persists to Redis; and a load generator simulates shoppers.

```
browser -> frontend :8080 (Go, HTTP)

  frontend -> productcatalogservice :3550  (Go)
  frontend -> currencyservice       :7000  (Node)
  frontend -> cartservice           :7070  (.NET)
  frontend -> recommendationservice :8080  (Python)
  frontend -> shippingservice       :50051 (Go)
  frontend -> checkoutservice       :5050  (Go)
  frontend -> adservice             :9555  (Java)

  checkoutservice -> paymentservice :50051 (Node)
  checkoutservice -> currencyservice:7000
  checkoutservice -> shippingservice:50051
  checkoutservice -> emailservice   :5000  (Python)

  cartservice -> redis-cart         :6379  (Redis)

  loadgenerator (Python/Locust) -> frontend  (synthetic shoppers)
```

All backend calls above are gRPC (protobuf) unless noted.

As a call list (real names and ports from `kubernetes-manifests.yaml`):

- `browser -> frontend:8080` (HTTP)
- `frontend -> productcatalogservice:3550` (Go)
- `frontend -> currencyservice:7000` (Node)
- `frontend -> cartservice:7070` (.NET)
- `frontend -> recommendationservice:8080` (Python)
- `frontend -> shippingservice:50051` (Go)
- `frontend -> checkoutservice:5050` (Go)
- `frontend -> adservice:9555` (Java)
- `checkoutservice -> paymentservice:50051` (Node)
- `checkoutservice -> currencyservice:7000`, `shippingservice:50051`, `emailservice:5000` (Python)
- `cartservice -> redis-cart:6379` (Redis)
- `loadgenerator -> frontend:80` (Locust hits the frontend Service, not the Pod)

Notice the two faces of port 8080: the frontend *serves HTTP on 8080* while the recommendation
service *serves gRPC on 8080*. Ports are per-container agreements, not global constants — another
reason names, not ports, are the stable addressing unit (below).

### Name-Based Addressing: DNS as Service Discovery

Services get a stable name and a virtual ClusterIP. From anywhere in the cluster, that name resolves
for free through CoreDNS (the cluster's DNS), so pods never hardcode each other's changing IPs. The
manifest wires services together with exactly such names in environment variables:

```yaml
env:
- name: PRODUCT_CATALOG_SERVICE_ADDR
  value: "productcatalogservice:3550"
- name: SHOPPING_ASSISTANT_SERVICE_ADDR
  value: "shoppingassistantservice:80"
```

Each `..._ADDR` is `<service-name>:<port>`. The full DNS name is
`<service>.<namespace>.svc.cluster.local`, and Kubernetes' search domains make the short name
`productcatalogservice:3550` work from inside the `online-boutique` namespace. `Module 05 ->
Kubernetes Services` covers how the ClusterIP and kube-proxy turn that name into real packets; for
now, understand that *service discovery here is DNS*, which is why the lab below could be a DNS
lookup.

### Failure Ripple and Dependency Coupling

Because every call is synchronous, a single downed backend is felt *immediately* by every caller up
the chain. The most visible case is the frontend: its home page (`/`) composes content from
product catalog, cart, currency, recommendations, and ads. When a required backend (for example
`cartservice`) is unreachable, the frontend home page returns **HTTP 500** to the browser.

That single fact explains the `frontend-check` init container from Module 02:
`loadgenerator` waits for HTTP 200 from `frontend:80`, and since 200 only arrives when the whole
dependency line beneath the frontend is healthy, the init container is secretly waiting on
`cartservice`, `productcatalogservice`, and the rest. The designer's intent was "don't start the
load test before the shop is up"; the *effect* is that the load test starts only when the whole
dependency graph is healthy. That is dependency coupling in action, and it is the real lesson: in a
synchronous architecture, availability at the top is the product of availability all the way down.
This is why every Deployment runs readiness probes and why `scripts/04-deploy.sh` waits on every
service's rollout before calling the deploy done.

### The Optional Shopping Assistant

`shoppingassistantservice` is an *optional* upstream service that needs Google Cloud Gemini and
AlloyDB. It is not part of the `v0.10.7` release manifest — no Deployment, no Service, no
ServiceAccount ships for it — and it is disabled by design in the upstream frontend
(`ENABLE_ASSISTANT` is commented out). The `SHOPPING_ASSISTANT_SERVICE_ADDR=shoppingassistantservice:80`
environment variable remains in the frontend template as a latent hook, but nothing listens on that
name. This project therefore runs 11 application services plus redis-cart, not 12-plus-1.

### Polyglot Freedom and Its Engineering Cost

A microservice architecture is not required to be polyglot, but it makes polyglot possible. Online
Boutique is deliberately multi-language:

| Language | Services |
|---|---|
| Go | frontend, productcatalogservice, shippingservice, checkoutservice |
| .NET (C#) | cartservice |
| Java | adservice |
| Node.js | currencyservice, paymentservice |
| Python | recommendationservice, emailservice, loadgenerator (Locust) |
| (infrastructure) | redis-cart (Redis) |

That is five language ecosystems coexisting behind one storefront — evidence of the "tech freedom"
row of the table. The *cost* is equally real and should always be counted: every service has its
own Dockerfile (cartservice's is nested one directory deeper than the others), its own dependency
lockfile, its own runtime characteristics, and its own build path. In this project that cost shows
up concretely: upstream ships `linux/amd64` images only, so `onlineBoutique/scripts/03-build-push-images.sh`
had to build **all 11 services for `linux/arm64` from source**, one `docker buildx` invocation per
service, and `cartservice` (.NET) even needed forced `TARGETARCH=arm64` build args to avoid shipping
an amd64 binary labeled as arm64. Freedom comes with a build farm; that is the honest trade-off.

## Hands-On Lab

Prereq: `online-boutique` deployed on `dev-cluster`.

**1. Render the service graph from the cluster itself.**

```bash
kubectl get svc -n online-boutique
```

Expected (ClusterIPs vary):

```text
NAME                  TYPE           CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
adservice             ClusterIP      10.43.20.15    <none>        9555/TCP   8d
cartservice           ClusterIP      10.43.16.41    <none>        7070/TCP   8d
checkoutservice       ClusterIP      10.43.24.77    <none>        5050/TCP   8d
currencyservice       ClusterIP      10.43.11.3     <none>        7000/TCP   8d
emailservice          ClusterIP      10.43.18.92    <none>        5000/TCP   8d
frontend              ClusterIP      10.43.9.118    <none>        80/TCP     8d
frontend-external     LoadBalancer   10.43.30.201   <pending>     80/TCP     8d
paymentservice        ClusterIP      10.43.27.63    <none>        50051/TCP  8d
productcatalogservice ClusterIP      10.43.21.140   <none>        3550/TCP   8d
recommendationservice ClusterIP      10.43.14.55    <none>        8080/TCP   8d
redis-cart            ClusterIP      10.43.19.210   <none>        6379/TCP   8d
shippingservice       ClusterIP      10.43.22.8     <none>        50051/TCP  8d
```

Map the `PORT(S)` column to the diagram above: `9555` ad, `3550` product catalog, `7000` currency,
`7070` cart, `8080` recommendation, `50051` shipping and payment, `5050` checkout, `5000` email,
`6379` redis. Notes worth making: `frontend` is exposed to the world only through
`frontend-external` (a `LoadBalancer` that stays `Pending` on Floci, so `scripts/05-verify.sh` uses
`kubectl port-forward`), and `loadgenerator` has **no** Service — it only sends traffic out, so
nothing needs to route to it. `emailservice`'s port looks odd (service :5000 -> container :8080): a
reminder that service ports are agreements, and `kubectl get svc` shows the service-side port.

**2. Watch name-based discovery work (DNS).**

The frontend runs a distroless image, so it has no shell to `exec` into. Instead, run a throwaway
`busybox` Pod from the exact image this project reuses (`busybox:1.38.0`) and resolve the service
name from the empty `nettest` container:

```bash
kubectl run nettest --rm -i --restart=Never \
  --image=busybox:1.38.0 -- \
  nslookup productcatalogservice.online-boutique.svc.cluster.local
```

Expected:

```text
Server:         10.43.0.10
Address:        10.43.0.10:53

Name:   productcatalogservice.online-boutique.svc.cluster.local
Address: 10.43.21.140
```

The `10.43.0.10` answer is CoreDNS; `10.43.21.140` is the Service's ClusterIP from
`kubectl get svc` above. From inside the `online-boutique` namespace the short name
also works (try running the same Pod with `-n online-boutique` and
`getent hosts productcatalogservice`). This is the exact mechanism behind the manifest's
`productcatalogservice:3550` environment variables: DNS, not IPs, is how these 11 services find each
other. (`Module 05` dives into how that ClusterIP becomes routing rules.)

**3. Read the load generator's live report.**

`loadgenerator` runs Locust, which periodically prints a latency/error table to stdout:

```bash
kubectl logs -n online-boutique -l app=loadgenerator --tail=20
```

Expected (numbers vary continuously):

```text
2026-09-24T12:03:17Z [    128] Type     Name                                     # reqs      # fails |    Avg     Med |   req/s  failures/s
2026-09-24T12:03:17Z [    128] --------|----------------------------------------|-------|-------------|--------|--------|--------|--------
2026-09-24T12:03:17Z [    128] GET      /                                         45         0      |     91      82 |   4.50     0.00
2026-09-24T12:03:17Z [    128] GET      /product/OLJCESPC7Z                       45         0      |     87      79 |   4.50     0.00
2026-09-24T12:03:17Z [    128] POST     /cart                                    103         0      |     58      51 |  10.30     0.00
2026-09-24T12:03:17Z [    128] --------|----------------------------------------|-------|-------------|--------|--------|--------|--------
2026-09-24T12:03:17Z [    128]          Aggregated                               410         0      |     73      65 |  41.00     0.00
```

The `-l app=loadgenerator` selects the Pod by label (the same selector pattern from Module 02).
Key readings: the `GET`/`POST` rows are individual shopper flows (home page, product page, cart
additions), and the **`Aggregated` row with failures near `0.00`** is the whole-report health check
your browser traffic will not show you: the shop really serves the synthetic it is paging. If you
killed one backend, you would see failures here climb immediately — the observable face of Module
03's failure-ripple lesson. When done, clean up the temp pod with `kubectl delete pod nettest`
(if `--rm` did not already remove it).

## Common Pitfalls

### Assuming a monolith is "wrong"
Monoliths are simpler operationally and were the correct first step for many products. Evaluate the
trade-off table honestly: the failing pattern is a monolith *pretending* to be microservices (shared
database, shared deploy train).

### Shared databases between services
"Database per service" means cart data belongs to cartservice. If two services read the same table,
they are coupled and can be broken by one another's schema changes. In this project, only
cartservice touches `redis-cart`.

### Hardcoding IPs or port meanings
Pod IPs die with Pods, and ports are per-container agreements (recall `emailservice`, or frontend
HTTP :8080 vs recommendation gRPC :8080). Always address by service name and read the manifest for
port meaning.

### Forgetting the namespace on DNS and kubectl
`getent hosts productcatalogservice` only works *inside* the namespace. From the default namespace,
use the FQDN (`<svc>.online-boutique.svc.cluster.local`) or pass `-n online-boutique`.

### Trying to `exec` into a distroless image
The frontend (and most services) run distroless: no shell, no `sh`. Use a sidecar Pod like
`busybox:1.38.0` for network debugging — exactly why the project itself uses that image for the
`frontend-check` init container.

### Treating the Locust table as pass/fail per row
Only the **Aggregated** row gives the overall error rate; a single endpoint row may show failures
while the shop itself is fine (or vice versa). Read the aggregate.

### Rebuilding one image and expecting other pods to change
`imagePullPolicy: IfNotPresent` reuses cached tags (Module 02). After a rebuild, evict the cached
image in k3s containerd (`crictl rmi`) — the helper in `03-build-push-images.sh` — or the "new"
code you deploy is the old code.

## Key Takeaways

- Microservices buy independent scaling, deployment, and technology choice; they pay for it with
  distributed complexity, network dependency, and operations load.
- The principles behind every service here: single responsibility, bounded contexts, database per
  service, explicit API contracts (protobuf), name-based discovery, resilience, observability.
- Online Boutique is a fully *synchronous* system: HTTP from the browser, gRPC (protobuf over
  HTTP/2) between backends, no message broker anywhere.
- Services address each other by DNS name (`productcatalogservice:3550`), not by IP; CoreDNS turns
  those names into ClusterIPs.
- Synchronous coupling means the frontend home page returns HTTP 500 when a backend is down — the
  `frontend-check` init container that waits on frontend :200 is really waiting on the whole dependency
  graph.
- Polyglot freedom has a build cost: 5 languages means 11 Dockerfiles and 11 arm64 build paths, all
  automated in `03-build-push-images.sh`.

## Review Questions

1. Give one pro and one con of microservices that each has *directly* to the fact that services
   communicate over a network.
2. This project is entirely synchronous. Name the two transports used and, for each, which pair of
   components talks that way.
3. Which Online Boutique service owns the cart data, and what specific "database per service"
   artifact demonstrates it?
4. The manifest sets `PRODUCT_CATALOG_SERVICE_ADDR=productcatalogservice:3550`. What exactly does
   that name resolve to at runtime, and why is it better than a hardcoded IP?
5. The loadgenerator's init container polls HTTP 200 on `frontend:80`. Why is that effectively
   waiting on the health of several unrelated backends?
6. Name three things a service mesh adds on top of the plain pod-to-pod networking this project
   uses.
7. List the five programming languages in the shop and the engineering cost each language adds to
   the build pipeline.

### Answers

1. Pro: each service scales and deploys independently (only the hot service needs more replicas).
   Con: every call crosses a network boundary, so latency, timeouts, and partial failures become
   normal cases that must be designed for.
2. HTTP (browser to the Go frontend on :8080) and gRPC with protobuf (frontend to all backends and
   checkout to its dependencies). Nothing uses a message broker.
3. `cartservice` owns the cart; it is the only consumer of the `redis-cart` Redis instance
   (`cartservice -> redis-cart:6379`).
4. It resolves to the ClusterIP of the `productcatalogservice` Service via CoreDNS, which then
   forwards to whatever Pod currently runs behind it (Module 05). A hardcoded IP breaks the moment
   a Pod is rescheduled; the stable name survives.
5. Because the frontend page is composed synchronously from product catalog, cart, currency, and
   more, HTTP 200 only appears when every required downstream call succeeds. Waiting for 200 is
   waiting on the whole dependency graph.
6. mTLS between services, transparent retries/timeouts/circuit breaking, traffic splitting
   (canaries), and per-call metrics/tracing.
7. Go, .NET (C#), Java, Node.js, Python. Each adds a Dockerfile, dependency management, a runtime,
   and a `linux/arm64` build path with its own quirks (e.g., cartservice's forced `TARGETARCH`), all
   automated in `03-build-push-images.sh`.

*Next: Module 04 (`../04-online-boutique-deep-dive.md`) walks every one of the 11 services — code,
protocol, and manifest — end to end.*
