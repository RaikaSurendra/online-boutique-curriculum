---
layout: module
title: "Module 04: Online Boutique Deep Dive"
slug: 04-online-boutique-deep-dive
meta:
  part: Part II — The Application
  subtitle: All 11 services, languages, ports, and the release manifest
---

# Module 04: Online Boutique Deep Dive

Module 03 gave you the theory of microservices: bounded contexts, polyglot runtimes, and
service-to-service calls. Module 04 opens the one file that turns that theory into a running
shop. Everything in this module references a single real artifact:

```
onlineBoutique/manifests/kubernetes-manifests.yaml
```

That 980-line manifest is the upstream Online Boutique release `v0.10.7`
(GoogleCloudPlatform/microservices-demo) with every image reference rewritten from Google's
Artifact Registry to the Floci ECR registry on this machine. We will dissect what is inside,
why it is shaped the way it is, how the services find each other, and how the pieces you
learned in Module 02 (Deployments, Services, ServiceAccounts, probes, resources) come together.

## Learning Objectives

By the end of this module you will be able to:

- Read a single multi-document Kubernetes manifest and list the objects it declares
  (12 Deployments, 12 Services, 11 ServiceAccounts).
- Explain what each of the 12 boutique components does and which language/runtime it is
  written in.
- Trace service discovery: how `host:port` environment variables plus DNS let one pod call
  another by short name.
- Parse a rewritten container image reference
  `000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/<svc>:v0.10.7` and explain
  where each piece (registry host:port / repository / tag) points.
- Read resource requests/limits and probes across the manifest and predict what breaks when
  they are wrong.
- Run the five diagnostic commands that prove the shop's wiring is correct.

## Prerequisites

Module 00, 01, 02, 03. You should have already run `scripts/04-deploy.sh` from
`onlineBoutique/` so the namespace `online-boutique` is live on `dev-cluster`.

## Time estimate

Reading: 60 min · Hands-on: 45 min

## Concepts

### 4.1 The monolithic manifest: one file, many documents

`kubernetes-manifests.yaml` is not a single YAML document. It is a sequence of many YAML
documents joined by `---` separators. Kubernetes treats each document as a separate object and
`kubectl apply -f` sends all of them to the API server in one go:

```
-----------------      -----------------      -----------------
| Deployment     |     | Service        |     | ServiceAccount |
| adservice      | --- | adservice      | --- | adservice      |
-----------------      -----------------      -----------------
        \                   ...                         \
         \                  ...                          \
-----------------      -----------------      -----------------
| Deployment     |     | Service        |     | ServiceAccount |
| shippingservice| --- | shippingservice| --- | shippingservice|
-----------------      -----------------      -----------------
              (repeated until the end of the file)
```

Running `scripts/04-deploy.sh` calls `kubectl apply -f "$MANIFEST" -n "$NAMESPACE"` against
this one file, so a single command creates 35 objects. Grouping every object of an
application into one file is fast, but it is called a *monolithic manifest* because it has
real drawbacks:

- **No surgical deployment.** Touching one Deployment means re-applying all 35 objects. You
  cannot scale up just `cartservice` without re-sending the whole file.
- **Poor blame and review.** In a repo, one giant file means every component's history is
  intertwined. Teammates reviewing a frontend change must wade through the cartservice
  section too.
- **Namespace coupling.** The manifests assume one namespace for everything. Splitting by
  component lets you give each team its own namespace later.
- **Conflicting defaults.** In this file, `redis-cart` and `loadgenerator` have custom
  resources while most services share the same tiny defaults. Spotting that difference is
  easier when each component has its own file.

That is why real projects split manifests per component (a `deploy/` folder with one file per
service) and often render them with a templating tool such as Kustomize or Helm (Module 10).
For a lab whose goal is *understanding*, the single file is actually an advantage: the whole
system is visible at once.

Let us verify the object counts rather than trust them. The file literally contains 12
Deployments, 12 Services, and 11 ServiceAccounts:

```
$ kubectl get deploy,svc,sa -n online-boutique
NAME                                   READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/adservice               1/1     1            1           118m
deployment.apps/checkoutservice         1/1     1            1           118m
deployment.apps/cartservice             1/1     1            1           118m
deployment.apps/currencyservice         1/1     1            1           118m
deployment.apps/emailservice            1/1     1            1           118m
deployment.apps/frontend                1/1     1            1           145m
deployment.apps/loadgenerator           1/1     1            1           118m
deployment.apps/paymentservice          1/1     1            1           118m
deployment.apps/productcatalogservice   1/1     1            1           118m
deployment.apps/recommendationservice   1/1     1            1           118m
deployment.apps/redis-cart              1/1     1            1           118m
deployment.apps/shippingservice         1/1     1            1           118m

NAME                            TYPE           CLUSTER-IP      EXTERNAL-IP   PORT(S)        AGE
service/adservice               ClusterIP      10.43.26.144    <none>        9555/TCP       118m
service/cartservice             ClusterIP      10.43.232.151   <none>        7070/TCP       118m
service/checkoutservice         ClusterIP      10.43.77.63     <none>        5050/TCP       118m
service/currencyservice         ClusterIP      10.43.54.185    <none>        7000/TCP       118m
service/emailservice            ClusterIP      10.43.192.111   <none>        5000/TCP       118m
service/frontend                ClusterIP      10.43.9.205     <none>        80/TCP         145m
service/frontend-external       LoadBalancer   10.43.47.17     172.17.0.4    80:32597/TCP   145m
service/paymentservice          ClusterIP      10.43.101.28    <none>        50051/TCP      118m
service/productcatalogservice   ClusterIP      10.43.157.132   <none>        3550/TCP       118m
service/recommendationservice   ClusterIP      10.43.12.43     <none>        8080/TCP       118m
service/redis-cart              ClusterIP      10.43.233.35    <none>        6379/TCP       118m
service/shippingservice         ClusterIP      10.43.238.51    <none>        50051/TCP      118m
```

Note that `frontend` owns two Services: the internal `frontend` (ClusterIP, port 80) and the
public `frontend-external` (LoadBalancer, port 80), while `loadgenerator` owns no Service at
all because nothing needs to call it. That is where 12 Deployments + 12 Services come from.
Ten of the remaining eleven components have exactly one Deployment plus one Service; the
eleventh, `redis-cart`, has a Deployment and a Service and is the only one with **no**
ServiceAccount of its own (it runs as the namespace's `default` ServiceAccount), which is why
the count is 11 ServiceAccounts, not 12.

### 4.2 Complete inventory

| Component | Kinds in the manifest | Language / Runtime | Container port |
|---|---|---|---|
| `frontend` | Deployment, Service `frontend` (ClusterIP :80), Service `frontend-external` (LoadBalancer :80) | Go | 8080 |
| `adservice` | Deployment, Service, ServiceAccount | Java (Spring Boot) | 9555 |
| `cartservice` | Deployment, Service, ServiceAccount | .NET 10 | 7070 |
| `checkoutservice` | Deployment, Service, ServiceAccount | Go | 5050 |
| `currencyservice` | Deployment, Service, ServiceAccount | Node.js | 7000 |
| `emailservice` | Deployment, Service, ServiceAccount | Python | 8080 (container) / 5000 (Service) |
| `loadgenerator` | Deployment, ServiceAccount (no Service) | Python (Locust) | none (outbound only) |
| `paymentservice` | Deployment, Service, ServiceAccount | Node.js | 50051 |
| `productcatalogservice` | Deployment, Service, ServiceAccount | Go | 3550 |
| `recommendationservice` | Deployment, Service, ServiceAccount | Python | 8080 |
| `shippingservice` | Deployment, Service, ServiceAccount | Go | 50051 |
| `redis-cart` | Deployment, Service (no ServiceAccount) | Redis | 6379 |

Three signals in this table deserve attention before we go any deeper:

1. **Polyglot by design.** The same shop mixes Go (frontend, checkout, catalog, shipping),
   Java (ads), .NET (cart), Node.js (currency, payment), Python (email, recommendations,
   loadgenerator), and Redis. Each team picks the best tool for its bounded context; the
   cluster's job is to be language-agnostic.
2. **Port 50051 is reused.** `paymentservice` and `shippingservice` both listen on host port
   `50051`. That is legal because each runs in its own Pod, and each Pod has its own network
   namespace. Ports only collide if *two containers share one Pod network namespace*.
3. **`emailservice` is the odd one out.** Its container listens on 8080 (see the `PORT`
   environment variable) but its Service advertises port 5000 and forwards to `targetPort:
   8080`. We decode this precisely in section 4.4.

### 4.3 What each service does in the shop

- **frontend** (Go, :8080) — The single-page browser UI. It renders catalog, cart, checkout
  pages, and the ads banner. It is the only component humans see; every other service is
  reached only through it.
- **adservice** (Java/Spring Boot, :9555) — Serves text ads ("Get 10% off!") that decorate the
  product and cart pages, matching a keyword to a canned campaign.
- **cartservice** (.NET 10, :7070) — Holds the shopping cart in a Redis instance
  (`redis-cart`) and exposes add/get/empty operations over gRPC. It is the shopping state
  between browsing and checking out.
- **checkoutservice** (Go, :5050) — The orchestration hub: when the user checks out it calls
  cart (read), currency (convert to USD), shipping (quote), payment (charge), and email
  (receipt), then empties the cart. It is the only service that talks to many others.
- **currencyservice** (Node.js, :7000) — Converts money between currencies (USD, EUR, GBP,
  JPY, ...) for the price shown on the page.
- **emailservice** (Python, :8080 container / :5000 Service) — Sends the order-confirmation
  emails on checkout. In the sandbox it only prints messages to its logs; there is no real
  SMTP.
- **loadgenerator** (Python Locust, no Service) — Synthesizes shoppers: it continuously
  browses the site, adds to carts, and checks out at a fixed rate, producing the traffic the
  rest of the lab observes. Nothing calls it, so it needs no Service. Its Deployment also
  runs an init container named `frontend-check` (busybox:1.38.0) that polls
  `http://frontend:80` up to 12 times before letting the Locust main container start — a
  dependency gate that prevents the load generator from hammering a shop that is not ready.
- **paymentservice** (Node.js, :50051) — Authorizes fake credit-card charges; it always
  approves except for a deliberately "declined" test card.
- **productcatalogservice** (Go, :3550) — Serves the static catalog of products (name,
  price, image, categories) that every page's product list is drawn from.
- **recommendationservice** (Python, :8080) — Returns "You might also like" products for a
  cart or product page, using a simple co-occurrence heuristic on the catalog.
- **shippingservice** (Go, :50051) — Computes shipping cost from a fixed fee plus a per-item
  charge, and returns a fake tracking quote. It runs on gRPC port 50051.
- **redis-cart** (Redis, :6379) — The state store backing `cartservice`. It has no business
  logic of its own; it just holds serialized carts.

### 4.4 Service discovery: `host:port` + DNS

A Pod cannot know IP addresses of other Pods in advance. Instead, every component is told,
through environment variables, the **Service name and Service port** of each dependency — the
`host:port` pair. The trick is that "host" is a DNS name, not an IP, so it stays valid no
matter how many times Pods restart and change IPs.

The `frontend` Deployment in the manifest declares every downstream dependency it calls:

```yaml
env:
- name: PRODUCT_CATALOG_SERVICE_ADDR
  value: "productcatalogservice:3550"
- name: CURRENCY_SERVICE_ADDR
  value: "currencyservice:7000"
- name: CART_SERVICE_ADDR
  value: "cartservice:7070"
- name: RECOMMENDATION_SERVICE_ADDR
  value: "recommendationservice:8080"
- name: SHIPPING_SERVICE_ADDR
  value: "shippingservice:50051"
- name: CHECKOUT_SERVICE_ADDR
  value: "checkoutservice:5050"
- name: AD_SERVICE_ADDR
  value: "adservice:9555"
```

Read any line as `destination-service-name:destination-service-port`. For example, the value
`cartservice:7070` means "connect to the cartservice Service, using the port number that
Service exposes (7070)". `checkoutservice` declares a similar set plus the three services it
needs that frontend does not:

```yaml
env:
- name: PRODUCT_CATALOG_SERVICE_ADDR
  value: "productcatalogservice:3550"
- name: SHIPPING_SERVICE_ADDR
  value: "shippingservice:50051"
- name: PAYMENT_SERVICE_ADDR
  value: "paymentservice:50051"
- name: EMAIL_SERVICE_ADDR
  value: "emailservice:5000"
- name: CURRENCY_SERVICE_ADDR
  value: "currencyservice:7000"
- name: CART_SERVICE_ADDR
  value: "cartservice:7070"
```

Notice the consistency rules these blocks imply:

- The **port in the Address must be the Service port**, not the container port. `checkoutservice`
  calls `emailservice:5000` because the emailservice Service port is 5000, even though the
  container listens on 8080. If the Service port changes, every caller's `*_ADDR` variable
  must change with it.
- The address is a **Service name, never a Pod name**. The `emailservice` pod could be deleted
  and recreated with a new IP; `emailservice:5000` still resolves because the Service stays.
- Values use `SERVICE_ADDR` naming and are decoupled from runtime ports by the Service's own
  `port`/`targetPort` fields (Module 05 covers this in depth).

This pattern is the canonical Kubernetes service-discovery primitive: *environment variables
for contract, DNS for location, Service objects for stability*. The shop has no service
mesh, no API gateway, and no central registry; the same mechanism that works on two Pods
also works on 2,000.

### 4.5 Image references: the Floci ECR rewrite

Every application container in the manifest names a container image. Look at the `adservice`
Deployment:

```yaml
image: 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/adservice:v0.10.7
```

Decompose the reference from right to left:

```
000000000000.dkr.ecr.us-east-1.localhost:4566 / microservices-demo / adservice : v0.10.7
+----------------- registry host:port -----------------+  +----- repository ------+  + tag +
                 (where to pull)                             (account/repo path)     (version)
```

- **Registry host:port** — `000000000000.dkr.ecr.us-east-1.localhost:4566`. The account
  number `000000000000` is Floci's well-known dummy AWS account ID (everything inside the
  sandbox uses it). `us-east-1` is the region, `.localhost` is the DNS suffix that resolves
  to this Mac, and `:4566` is the port where Floci's ECR endpoint is published
  (`http://localhost:4566`). Container runtimes need a port on a *registry* only when the
  registry is not the default port 443; Docker-derived tooling appends a tag automatically but
  never guesses the port, which is exactly why the rewrite keeps `:4566` spelled out.
- **Repository** — `microservices-demo/<svc>`. The top-level name is the artifact repository
  and the last segment is the image within it. Each of the twelve services is pushed to its
  own image under the same parent repository in `scripts/03-build-push-images.sh`.
- **Tag** — `v0.10.7`. Ties every image to the exact upstream release this project was
  pinned to. Together with a digest (the `@sha256:...` form, which `frontend-check`'s
  busybox uses) tags are how you reproduce a deployment.

The upstream file does **not** contain this value. The original line is:

```yaml
image: us-central1-docker.pkg.dev/online-boutique-ci/microservices-demo/adservice:v0.10.7
```

`us-central1-docker.pkg.dev` is Google Cloud's Artifact Registry — a real public registry
where Google publishes the reference images as `linux/amd64`. That cannot work here: this
machine's k3s node is `arm64` (upstream images are `linux/amd64`), so pulling them would
require emulation or fail outright, and any pull would leak out of the Floci sandbox. The
rewrite is done mechanically by a single `sed` invocation in `onlineBoutique/scripts/04-deploy.sh`
when run as `scripts/04-deploy.sh --rebuild-manifest`:

```bash
sed -E \
  -e 's#us-central1-docker\.pkg\.dev/online-boutique-ci/microservices-demo/#000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/#g' \
  "$OB_ROOT/microservices-demo/release/kubernetes-manifests.yaml" > "$MANIFEST"
```

That substitution is the backbone of the whole lab: images are rebuilt for `arm64` and pushed
to the Floci ECR registry (sidecar API + real image storage), and the manifest is regenerated
to point at them. The stored `kubernetes-manifests.yaml` in this repo is already rewritten,
so a plain `scripts/04-deploy.sh` just applies it. The flag exists to re-derive it from a
fresh upstream copy without hand-editing.

Two images do **not** follow the rewrite: `redis:alpine` (redis-cart) and
`busybox:1.38.0@sha256:...` (the loadgenerator init container). They are small, general
purpose tools that ship in the base image cache and need no microservices-demo build.

### 4.6 Resources and probes

Most micro-service containers follow the same resource contract, visible on e.g. the
`shippingservice` container:

```yaml
resources:
  requests:
    cpu: 100m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 128Mi
```

- **requests** (`100m` CPU, `64Mi` RAM) are the minimum the scheduler guarantees; the k3s
  scheduler uses them to place pods on the node. `100m` = 0.1 of one CPU core.
- **limits** (`200m`, `128Mi`) are the ceiling the container may not exceed; exceeding memory
  limits triggers an OOM kill (a classic CrashLoopBackOff in Module 11).

Surprisingly large or small deviations are intentional teaching signals:

| Container | requests (cpu/mem) | limits (cpu/mem) | Why it differs |
|---|---|---|---|
| most services | 100m / 64Mi | 200m / 128Mi | tiny stateless default |
| `adservice` | 200m / 180Mi | 300m / 300Mi | JVM/Spring Boot needs a big heap |
| `recommendationservice` | 100m / 220Mi | 200m / 450Mi | Python with heavy per-call catalog copies |
| `loadgenerator` | 300m / 256Mi | 500m / 512Mi | synthetic load must actually push CPU |
| `redis-cart` | 70m / 200Mi | 125m / 256Mi | stateful store, small CPU but a real dataset |

Every deployment also declares probes. The frontend is the only HTTP one and is the one you
will *see*:

```yaml
readinessProbe:
  initialDelaySeconds: 10
  httpGet:
    path: "/_healthz"
    port: 8080
livenessProbe:
  initialDelaySeconds: 10
  httpGet:
    path: "/_healthz"
    port: 8080
```

Fundamentally, Module 02 said a *readiness* probe gates traffic to the pod (unready pods have
their Service endpoints removed) and a *liveness* probe restarts stuck containers
(`--restart=Always`). The boutique uses a small `/_healthz` handler on frontend for both, and
every other service uses its gRPC equivalent on the same port it serves on (e.g. `grpc: port:
9555` on adservice) or a `tcpSocket` check on `redis-cart` (6379). When you load-test the shop
in Module 09, watch how readiness gates the Service's endpoint list before the load generator
can even start.

### 4.7 Shopping assistant: a feature disabled by design

The frontend manifest contains one buried clue that upstream shipped but did not enable:

```yaml
- name: SHOPPING_ASSISTANT_SERVICE_ADDR
  value: "shoppingassistantservice:80"
...
# - name: ENABLE_ASSISTANT
#   value: "true"
```

The `SHOPPING_ASSISTANT_SERVICE_ADDR` is set, but no such Deployment or Service exists
anywhere in this manifest — and the feature switch `ENABLE_ASSISTANT` is commented out. At
runtime the frontend code checks `ENABLE_ASSISTANT` first; because it is unset (falsy) the assistant
feature and its wand icon are never rendered, and the dangling address is never dialed. The
shop runs fine without it. This is a deliberate, upstream-blessed way to ship a feature
*opt-in*: the wiring contract (the `_ADDR` variable) is in place so that enabling the switch
later only requires deploying the missing service, not changing the frontend. Contrast it with
Module 03's point that an un-fenced call to a nonexistent dependency is a runtime failure:
here the dependency is fenced behind a feature flag that is simply off.

## Hands-On Lab

Prerequisite: `scripts/04-deploy.sh` has run and the namespace is healthy. Run these
statements against `dev-cluster`.

**1. Inventory the whole deployment.**

```bash
kubectl get deploy,svc,sa -n online-boutique
```

```text
NAME                                   READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/adservice               1/1     1            1           118m
deployment.apps/checkoutservice         1/1     1            1           118m
deployment.apps/frontend                1/1     1            1           145m
... (12 Deployments total)

NAME                            TYPE           CLUSTER-IP      EXTERNAL-IP   PORT(S)        AGE
service/frontend                ClusterIP      10.43.9.205     <none>        80/TCP         145m
service/frontend-external       LoadBalancer   10.43.47.17     172.17.0.4    80:32597/TCP   145m
...

NAME                                   SECRETS   AGE
serviceaccount/adservice               0         118m
...
```

Observe: 12 `deployment.apps/`, 12 `service/`, 11 `serviceaccount/` rows, and that
`frontend-external` is the only LoadBalancer.

**2. See the dependency wiring on the frontend.**

```bash
kubectl get deploy frontend -n online-boutique -o jsonpath='{.spec.template.spec.containers[0].env}' | python3 -m json.tool
```

```json
[
    { "name": "PORT", "value": "8080" },
    { "name": "PRODUCT_CATALOG_SERVICE_ADDR", "value": "productcatalogservice:3550" },
    { "name": "CURRENCY_SERVICE_ADDR", "value": "currencyservice:7000" },
    { "name": "CART_SERVICE_ADDR", "value": "cartservice:7070" },
    { "name": "RECOMMENDATION_SERVICE_ADDR", "value": "recommendationservice:8080" },
    { "name": "SHIPPING_SERVICE_ADDR", "value": "shippingservice:50051" },
    { "name": "CHECKOUT_SERVICE_ADDR", "value": "checkoutservice:5050" },
    { "name": "AD_SERVICE_ADDR", "value": "adservice:9555" }
]
```

Observe that every `*_ADDR` value is `servicename:serviceport` — exactly the pairs from
section 4.4. `SHOPPING_ASSISTANT_SERVICE_ADDR` is also set here; check that `ENABLE_ASSISTANT`
is commented out in the manifest so it never dials.

**3. The emailservice port twist.**

```bash
kubectl get svc emailservice -n online-boutique -o wide
```

```text
NAME           TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE    SELECTOR
emailservice   ClusterIP   10.43.192.111   <none>        5000/TCP   118m   app=emailservice
```

The Service advertises `5000`. Compare with the Deployment's containerPort 8080 and `PORT`
env 8080; `kubectl get svc emailservice -n online-boutique -o yaml | grep -E "port|targetPort"`
shows `port: 5000` / `targetPort: 8080`. Callers use 5000, the Service forwards to 8080.

**4. The LoadBalancer face.**

```bash
kubectl get svc frontend-external -n online-boutique
```

```text
NAME                TYPE           CLUSTER-IP    EXTERNAL-IP   PORT(S)        AGE
frontend-external   LoadBalancer   10.43.47.17   172.17.0.4    80:32597/TCP   145m
```

Observe the external IP `172.17.0.4` (the k3s node's Docker bridge IP) and the NodePort
`32597` published alongside port 80.

**5. Synthetic shoppers at work.**

```bash
kubectl logs -n online-boutique -l app=loadgenerator --tail=10
```

```text
Defaulted container "main" out of: main, frontend-check (init)
GET      /product/OLJCESPC7Z      622   0(0.00%) |  8    4   60   7 | 0.00  0.00
POST     /setCurrency             669   0(0.00%) | 12    9  130  16 | 0.30  0.00
--------|---------------------------------------|-----|---|------|---|--------|----
         Aggregated               5241   1(0.01%) | 10   4  324   8 | 1.80   0.00
Type     Name                      # reqs  # fails | Avg  Min Max Med | req/s  fail/s
```

Observe the Locust table refreshing in place: real requests (GET /, /product/..., POST
/cart/checkout) flowing through the shop, ~10 users at rate 1. That traffic is exactly what
other services' probes and endpoints respond to.

## Common Pitfalls

- **Using the container port instead of the Service port in `*_ADDR`.** `emailservice:8080`
  is wrong: the contract is the Service port. Failing calls produce status 14 (gRPC
  "unavailable")-style errors. Always read the value from the Service object, not the
  Deployment's `containerPort`.
- **Treating a multi-document file as one YAML object.** Missing a `---` separator (or adding
  an extra one) makes `kubectl apply` reject the whole file. Count objects with
  `kubectl get ... --no-headers | wc -l` when in doubt.
- **Trusting the original image reference.** A fresh clone's manifest still points at
  `us-central1-docker.pkg.dev/**` until you regenerate with `scripts/04-deploy.sh
  --rebuild-manifest`. Expect ImagePullBackOff (Module 11) if images were never pushed to the
  Floci ECR.
- **Assuming one Service per Deployment.** Frontend has two (internal + external) and
  loadgenerator has zero. Verify with `kubectl get svc -n online-boutique` before debugging
  "where is the service".
- **Editing generated manifests.** The header says the file is autogenerated; manual edits
  vanish on `--rebuild-manifest`. Change the build/deploy scripts instead.
- **Expecting the assistant to show.** The wand icon is disabled (`ENABLE_ASSISTANT` off).
  If another student forked the repo and enabled it, the shop still runs, but the missing
  service will log connection failures; that is the feature flag working as designed.

## Key Takeaways

- One 980-line manifest with `---` separators declares all 12 Deployments, 12 Services, and
  11 ServiceAccounts; that convenience also creates the coupling that motivates splitting.
- The shop is genuinely polyglot (Go, Java, .NET, Node.js, Python, Redis), and ports such as
  50051 are safely reused because each value lives in its own Pod network namespace.
- Service discovery here is the plain Kubernetes primitive: env-var `host:port` contracts the
  app, DNS the location, Service objects the stability.
- Image references are `registry-host:port / repository / tag`; this repo's are rewritten from
  Google Artifact Registry to `000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/*`
  by one `sed` in `04-deploy.sh`.
- Typical resource contract is 100m/64Mi requests, 200m/128Mi limits, with justified
  outliers; frontend exposes HTTP `/_healthz` probes while gRPC/TCP services probe their own
  port.
- The shopping-assistant `_ADDR` exists but `ENABLE_ASSISTANT` is off: a real example of a
  feature-flagged, opt-in capability shipped dormant.

## Review Questions

1. How many Deployments, Services, and ServiceAccounts does `kubernetes-manifests.yaml`
   declare, and which component uniquely has no Service of its own (and which has two)?
2. List four languages you can find in the boutique, and give one service per language.
3. The frontend calls `emailservice:5000`; the email pod listens on 8080. Why is the call
   correct?
4. Split
   `000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/checkoutservice:v0.10.7`
   into registry, repository, and tag, and say why the port `4566` appears.
5. Frontend's readiness and liveness probes use `httpGet` on `/_healthz`; `adservice` uses a
   gRPC probe on 9555. What does each probe type protect against, respectively?
6. `SHOPPING_ASSISTANT_SERVICE_ADDR` is set but the shop runs fine. Why? What upstream edit
   would actually turn the assistant on?

### Answers

1. 12 Deployments, 12 Services, 11 ServiceAccounts. `loadgenerator` has no Service
   (outbound only); `frontend` has two Services (`frontend` and `frontend-external`).
   `redis-cart` is the deployment without its own ServiceAccount (it uses `default`).
2. Go (frontend, checkoutservice, productcatalogservice, shippingservice), Java/Spring Boot
   (adservice), Node.js (currencyservice, paymentservice), Python (emailservice,
   recommendationservice, loadgenerator), .NET (cartservice).
3. Because the email Service object exposes port 5000 and forwards to the container's
   `targetPort: 8080`. Callers address the Service port; the Service hides the runtime port.
4. Registry: `000000000000.dkr.ecr.us-east-1.localhost:4566`; repository:
   `microservices-demo/checkoutservice`; tag: `v0.10.7`. `4566` is Floci's published ECR
   endpoint port on this machine.
5. Readiness gates the pod's presence in the Service's endpoints (traffic stops when the app
   is not ready); liveness triggers a containment restart when the process hangs, keeping a
   stuck pod from serving errors forever.
6. Because `ENABLE_ASSISTANT` is commented out — the frontend never opens a connection to the
   (nonexistent) assistant service. Turning the feature on requires uncommenting
   `ENABLE_ASSISTANT: "true"` (and deploying a real `shoppingassistantservice`).