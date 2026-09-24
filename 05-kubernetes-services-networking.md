---
layout: module
title: "Module 05: Kubernetes Services & Networking"
slug: 05-kubernetes-services-networking
meta:
  part: Part II — The Application
  subtitle: ClusterIP, LoadBalancer, NodePort, DNS, gRPC, ServiceLB
---

# Module 05: Kubernetes Services & Networking

Module 04 showed *that* every boutique service talks to its neighbors by `host:port`
environment variables. Module 05 explains *how* the host part of that address actually
resolves to a running Pod. This module covers the pod networking model, the Service object
(endpoints, kube-proxy), the three Service types the shop uses, CoreDNS, and why gRPC-heavy
microservices still work fine on top of plain TCP.

We keep grounding everything in the live cluster. Real values from `dev-cluster`
(namespace `online-boutique`) used throughout:

- Pod network: `10.42.0.0/16`; pod IPs look like `10.42.0.23`.
- Service network: `10.43.0.0/16`; Service (ClusterIP) IPs look like `10.43.x.x`.
- CoreDNS: the `kube-dns` ClusterIP is `10.43.0.10`.
- Node: one k3s server node `64ee2f523cd3` with internal IP `172.17.0.4`.
- `frontend-external`: LoadBalancer, EXTERNAL-IP `172.17.0.4`, ports `80:32597/TCP`.
- `cartservice` ClusterIP: `10.43.232.151`; frontend pod endpoint: `10.42.0.23:8080`.

## Learning Objectives

By the end of this module you will be able to:

- Explain the pod networking model: a flat, cluster-private IP per pod, and why pod IPs are
  not stable enough to be used directly by applications.
- Trace the full Service data path: selector, Endpoints/EndpointSlice, kube-proxy, and the
  ready pods behind the name.
- Distinguish ClusterIP, NodePort, and LoadBalancer, and explain which the boutique uses and
  why the LoadBalancer here is served by k3s's ServiceLB (klipper).
- Read the CoreDNS path: `kube-dns` at `10.43.0.10`, the `search` domains, FQDN vs short
  name, and why `cartservice` resolves only inside its own namespace.
- Explain why gRPC (HTTP/2) across many services is fine over kube-proxy and where
  connection reuse actually matters.
- Use `kubectl get svc`, `kubectl get endpoints`, `kubectl run` with busybox, and
  `kubectl port-forward` to debug name resolution and reachability end to end.

## Prerequisites

Module 02 (Pods, Deployments, Namespaces), Module 04 (the boutique manifest, the `*_ADDR`
wiring). The `online-boutique` namespace must be deployed.

## Time estimate

Reading: 75 min · Hands-on: 45 min

## Concepts

### 5.1 The pod networking model

Kubernetes gives every Pod its own network identity inside the cluster. This machine's k3s
node uses the default pod CIDR `10.42.0.0/16`, so each pod gets a private address like
`10.42.0.23`, and every pod can reach every other pod on that flat network directly — no NAT
between them. That part is simple and is a major reason microservices work here: the shop was
ported nearly unchanged from GKE because the network contract is identical.

The catch is that pod IPs are *ephemeral*. A pod restarts, gets rescheduled, or is replaced
during a rolling update and receives a fresh IP. If `frontend` hard-coded
`10.42.0.17` for `cartservice`, the address would break the moment that pod moved. Worse, a
Deployment may run several replicas of the same app, each with its own IP — "cartservice" is
*one logical thing* but many addresses.

For this reason no application in the boutique ever talks to a pod IP. It talks to a stable
*name*, and a Service object turns that name into a set of live pod IPs:

```
 app code            Service (stable name)         live Pods (changing IPs)
---------          ---------------------          ----------------------
 frontend  ------>  cartservice:7070      ------>  10.42.0.17:7070  (pod replica 1)
 (env var 'host')   ClusterIP 10.43.x.x            10.42.0.41:7070  (pod replica 2)
                    selector app=cartservice
```

The Service is the indirection layer that makes the "host" in `host:port` survivable.

### 5.2 Anatomy of a Service: selector, endpoints, kube-proxy

A Service is a YAML object with three jobs: *select* the pods, *record* their addresses, and
*forward* traffic to them. The pod side is just labeled Pods; the selector is what bridges
them.

```yaml
# backend.yaml -- a minimal teaching pair (labels app: demo)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
spec:
  selector:
    matchLabels:
      app: demo
  template:
    metadata:
      labels:
        app: demo
    spec:
      containers:
      - name: server
        image: nginx
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: demo
spec:
  type: ClusterIP
  selector:
    app: demo
  ports:
  - name: http
    port: 8080        # the Service port callers connect to
    targetPort: 80    # the port the container actually listens on
```

Reading the Service together with Module 04's `frontend` Service, every piece maps:

```yaml
# real snippet from kubernetes-manifests.yaml (frontend)
spec:
  type: ClusterIP
  selector:
    app: frontend
  ports:
  - name: http
    port: 80
    targetPort: 8080
```

- **`selector: app: frontend`** — the match that binds the Service to Pods. The Deployment
  labels its Pods `app: frontend`; any ready Pod carrying that label joins the set.
- **`port: 80` / `targetPort: 8080`** — callers connect to the Service on 80; kube-proxy
  rewrites the destination to the pod's port 8080. Two ports are standard: the polite
  Service-side port (which is what `*_ADDR` variables reference) and the container's real
  listening port.

When you create the Service, the control plane (specifically the endpoints controller) reads
the healthy Pods selected by the label and writes their addresses into an object you can
inspect directly:

```text
$ kubectl get endpoints frontend -n online-boutique
NAME       ENDPOINTS         AGE
frontend   10.42.0.23:8080   145m
```

(Newer clusters also expose the equivalent, richer `discovery.k8s.io/v1` EndpointSlice, which
is what the endpoints controller actually mints; `kubectl get endpoints` today is a thin view
over it.)

The data path that completes the picture:

```
            (1) master picks ready pods                     (2) every node programs its tables
 selector --------------------------> Endpoints/EndpointSlice -----> kube-proxy --> iptables/IPVS rules
   |                                            |                             |
   |-- matches pods labeled app=frontend        |-- 10.42.0.23:8080        +--|
   |                                                                          v
 connection to frontend:80 (ClusterIP)  -------------------------------->  DNAT hook -> 10.42.0.23:8080
```

`kube-proxy`, a component that runs on every node, watches the Endpoints and programs
netfilter (`iptables`, or on k3s typically `iptables`/`IPVS`) rules so that a connection to
the Service's ClusterIP:port is load-balanced to one of the ready pod IP:port entries. The
result is a classic name-to-address fan-out that survives pod churn: when a pod becomes
unready (readiness probe fails, Module 04), its address is withdrawn from the Endpoints and
the rules are re-written automatically.

### 5.3 Service types in depth

Kubernetes Service has four `spec.type` values. The boutique declares two of them —
ClusterIP and LoadBalancer — plus a third, NodePort, that appears only implicitly, because
every LoadBalancer service is also, under the hood, a NodePort.

**ClusterIP (the default).** The simplest and most common: an internal virtual IP plus DNS
entry, reachable only from inside the cluster. Eleven of the twelve boutique Services
(internal `frontend`, `cartservice`, `productcatalogservice`, and so on) are ClusterIP. This
is the right default: internal services should not be exposed outside the cluster at all —
only `frontend` needs a public door.

**NodePort.** A ClusterIP service that additionally publishes the *same high port on every
node*. When a Service needs one, the API server allocates a port number in 30000-32767
(`nodePort`); kube-proxy then listens for that port on all node IPs and forwards to the
ClusterIP. `frontend-external` shows `80:32597/TCP`, which reads *"Service port 80 is
reachable on every node's TCP port 32597."* On a real EKS cluster a user would hit
`http://<ANY_NODE_IP>:32597/`.

**LoadBalancer.** The external front door. On real AWS EKS, creating a LoadBalancer-type
Service triggers the cloud controller manager to provision an ELB/ALB in the VPC, which then
routes traffic to the NodePort on each node. `dev-cluster` has no AWS at runtime — so the
actual implementation here is k3s's built-in **ServiceLB**.

k3s ships a small controller called *klipper* (ServiceLB). It watches for LoadBalancer-type
Services and, for each one, creates a DaemonSet pod in `kube-system`:

```text
$ kubectl get ds -n kube-system | grep svclb
NAME                               DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR   AGE
svclb-frontend-external-90c9bfcd   1         1         1       1            1           <none>          144m
```

The pod's image is `rancher/klipper-lb:v0.4.13`. It binds the node's LoadBalancer port
(32597) and forwards to the Service's ClusterIP, which lets kube-proxy finish the balance to
the pods:

```
Browser --> host:32597 --> svclb (klipper-lb) --> ClusterIP 10.43.47.17:80 --> pod 10.42.0.23:8080
                          (DaemonSet, kube-system)   (kube-proxy rules)       (frontend pod)
```

That is exactly why `kubectl get svc frontend-external` reports an EXTERNAL-IP even though
there is no cloud:

```text
NAME                TYPE           CLUSTER-IP    EXTERNAL-IP   PORT(S)        AGE
frontend-external   LoadBalancer   10.43.47.17   172.17.0.4    80:32597/TCP   145m
```

`172.17.0.4` is not an AWS address. It is the k3s node's own IP on the Docker bridge inside
this Mac, chosen by ServiceLB as the "external" address it can announce. It is private to the
machine, which is why the lab reaches `frontend-external` with `port-forward` (see 5.6).

### 5.4 DNS and service discovery: CoreDNS

A Service name is only useful if the cluster turns it into an IP. k3s runs CoreDNS in
`kube-system`, exposed internally through a Service named `kube-dns` at ClusterIP
`10.43.0.10`:

```text
$ kubectl get svc -n kube-system
NAME       TYPE        CLUSTER-IP   PORT(S)                  AGE
kube-dns   ClusterIP   10.43.0.10   53/UDP,53/TCP,9153/TCP   4h49m
```

Every pod's `/etc/resolv.conf` is generated to point at CoreDNS, carrying the namespace's
name as its search domain:

```text
search default.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.43.0.10
options ndots:5
```

The canonical name of a Service is its FQDN:

```
<service>.<namespace>.svc.cluster.local
```

```text
$ kubectl run nettest --rm -i --image=busybox:1.38.0 -- nslookup cartservice.online-boutique.svc.cluster.local
Server:     10.43.0.10
Address:    10.43.0.10:53

Name:   cartservice.online-boutique.svc.cluster.local
Address: 10.43.232.151
```

`10.43.232.151` is the exact ClusterIP from `kubectl get svc cartservice`. Within the same
namespace you never need the FQDN: the `search` line plus `ndots: 5` means a bare name like
`cartservice` is tried first with each search-domain suffix appended. That is why the
boutique's `*_ADDR` variables can say just `cartservice:7070` — every caller lives in
`online-boutique`, so `cartservice` expands to `cartservice.online-boutique.svc.cluster.local`.

The flip side is a real trap: short names resolve *only inside their own namespace*. Start a
pod in `default` and ask for `cartservice` and CoreDNS answers `NXDOMAIN`, because none of
`cartservice.default.svc.cluster.local`, `cartservice.svc.cluster.local`, or
`cartservice.cluster.local` exists:

```text
** server can't find cartservice.default.svc.cluster.local: NXDOMAIN
** server can't find cartservice.svc.cluster.local: NXDOMAIN
```

Code that needs a Service in another namespace must use the full FQDN. (You can also pass
`-n online-boutique` to `kubectl run` so the probe pod is *inside* the right namespace.)

Putting it together, the frontend's `CART_SERVICE_ADDR=cartservice:7070` is resolved like so:

1. Frontend calls `getaddrinfo("cartservice")`; CoreDNS appends search suffixes, hits
   `cartservice.online-boutique.svc.cluster.local` and returns `10.43.232.151`.
2. The client opens a TCP connection to `10.43.232.151:7070` (the ClusterIP, not a pod!).
3. On the node, kube-proxy DNAT's the packet to a ready `cartservice` pod, e.g.
   `10.42.0.29:7070`, and replies flow back through the same connection.

### 5.5 gRPC in the boutique

Most service-to-service traffic in the shop is gRPC, synchronous RPC over HTTP/2. You will see
it everywhere in the manifest: `paymentservice` and `shippingservice` listen on the famous
gRPC port `50051`, `adservice` on `9555`, `cartservice` on `7070`. The frontend is special:
it speaks gRPC to its backends and plain HTTP (HTML/JSON) to browsers.

Two things matter about the networking layer here.

First, *to kube-proxy, gRPC is just TCP*. gRPC rides HTTP/2, and HTTP/2 runs on top of TCP,
so the Service data path of section 5.2 applies unchanged. There is no gRPC awareness in
iptables, ClusterIPs, or CoreDNS — the boutique's use of `port`/`targetPort`, selectors, and
probes for gRPC services is identical to HTTP services; only the probe *type* differs
(`grpc` probes on 50051/9555/... instead of `httpGet`).

Second, *connection reuse changes the traffic shape*. HTTP/2 multiplexes many concurrent
"requests" over a single long-lived TCP connection. A frontend calling `shippingservice` may
open one connection and keep it for the lifetime of the process rather than dialing per
request. Consequences:

- With few gRPC clients and persistent connections, load balancing at the connection level can
  concentrate traffic: the first node a client connected to may be the only one that ever
  serves it. gRPC clients normally smooth this with per-call load-balancing and connection
  failover, but the *service mesh* (istio/sidecar) that the manifest references in a stray
  annotation (`sidecar.istio.io/...`) is NOT running here.
- This is why services must handle connection churn gracefully. In Module 09 you will see the
  loadgenerator's Locust failures spike during a rolling update: clients hold connections to
  pods that are being drained, and robust clients re-resolve and reconnect.

So the one-line summary: gRPC needs no new Kubernetes machinery, but it does change how you
*think* about connections — reuse and channel behavior matter more than port count.

### 5.6 Network flow inside one node

Every Pod's traffic leaves the pod through a virtual Ethernet pair (veth) into a bridge that
k3s's default CNI, *flannel*, creates per node. Flannel assigns each pod its CIDR address
(`10.42.0.0/16` subnet this node owns) and, jointly with the node's route table, delivers
packets to the right destination — other pods on the same node, other nodes, and the host.
Keep it at this high level for now; the transport is a normal Linux bridge + routes, exactly
the mechanism Docker uses on this Mac.

```
   pod A (10.42.0.23)                    pod B (10.42.0.29)
      | veth0                                | veth1
      +------> cni0 bridge (flannel) <-------+
                  | route table / netfilter (kube-proxy)
                  v
       node eth0 = 172.17.0.4  (Docker bridge on the host)
```

The contrast that Module 08 leans on: on the Docker `bridge` network, container names do not
resolve via DNS (there is no CoreDNS on a plain bridge), which is exactly why `eksSetup`
creates the user-defined network `floci-net` whose Docker embedded DNS resolves sidecar names.
Inside the cluster, names resolve because CoreDNS exists; outside the cluster, on the host's
Docker bridge, they do not. Two different name-resolution worlds meet at the node boundary.

### 5.7 Why the lab uses port-forward (and what EXTERNAL-IP really is)

`frontend-external` announces EXTERNAL-IP `172.17.0.4:80` (via NodePort 32597). But that
address is the k3s container's IP on the *Docker bridge* — a host-local, private L2 segment,
not a public or host-routable endpoint. There is no cloud load balancer and no ingress here.
On real EKS the equivalent public IP would be assigned by AWS; in this emulated setup a
browser pointed at `172.17.0.4` reaches nothing useful from outside the machine, and even on
the host it is fragile.

`kubectl port-forward` sidesteps all of it: it opens a tunnel on `localhost:8080` and pipes
traffic to `frontend-external` in-cluster, exactly like `onlineBoutique/scripts/05-verify.sh`
does:

```bash
kubectl port-forward -n online-boutique svc/frontend-external 8080:80 &
curl -s -o /dev/null -w '%{http_code}' http://localhost:8080   # -> 200
```

This is the canonical access pattern for the whole course: curl `localhost` on the Mac, and
the tunnel delivers the request into the cluster. It also teaches a real production habit —
create the LoadBalancer object for IaC parity, but reach pods safely through a tunnel when
the Ingress/LB layer is absent.

## Hands-On Lab

**1. List every Service in the namespace.**

```bash
kubectl get svc -n online-boutique
```

```text
NAME                    TYPE           CLUSTER-IP      EXTERNAL-IP   PORT(S)        AGE
adservice               ClusterIP      10.43.26.144    <none>        9555/TCP       118m
cartservice             ClusterIP      10.43.232.151   <none>        7070/TCP       118m
checkoutservice         ClusterIP      10.43.77.63     <none>        5050/TCP       118m
currencyservice         ClusterIP      10.43.54.185    <none>        7000/TCP       118m
emailservice            ClusterIP      10.43.192.111   <none>        5000/TCP       118m
frontend                ClusterIP      10.43.9.205     <none>        80/TCP         145m
frontend-external       LoadBalancer   10.43.47.17     172.17.0.4    80:32597/TCP   145m
paymentservice          ClusterIP      10.43.101.28    <none>        50051/TCP      118m
productcatalogservice   ClusterIP      10.43.157.132   <none>        3550/TCP       118m
recommendationservice   ClusterIP      10.43.12.43     <none>        8080/TCP       118m
redis-cart              ClusterIP      10.43.233.35    <none>        6379/TCP       118m
shippingservice         ClusterIP      10.43.238.51    <none>        50051/TCP      118m
```

Observe: all ClusterIP (type column), the two 50051 entries sharing a port safely, and
`frontend-external` as the only non-ClusterIP.

**2. Look behind one Service name to the live pods.**

```bash
kubectl get endpoints frontend -n online-boutique
```

```text
NAME       ENDPOINTS         AGE
frontend   10.42.0.23:8080   145m
```

Observe: the pod IP (`10.42.0.x`, inside the pod CIDR) plus targetPort 8080 — the exact
pod:port kube-proxy will DNAT to. Do the same with a replica-scaled service later
(`kubectl scale deploy cartservice --replicas=2`; the endpoints line gains a second entry).

**3. Resolve a Service name from inside the cluster.**

```bash
kubectl run nettest --rm -i --image=busybox:1.38.0 -- getent hosts cartservice
```

Expected (with a busybox build that ships the `getent` applet, most often run *inside* the
same namespace, e.g. adding `-n online-boutique`):

```text
10.43.232.151   cartservice.online-boutique.svc.cluster.local cartservice
```

If your image lacks `getent` (a known busybox:1.38.0 surprise), use the verified
equivalents:

```bash
kubectl run nettest --rm -i --image=busybox:1.38.0 -- nslookup cartservice.online-boutique.svc.cluster.local
# Server: 10.43.0.10  Address: 10.43.0.10:53
# Name:   cartservice.online-boutique.svc.cluster.local
# Address: 10.43.232.151

kubectl run nettest --rm -i --image=busybox:1.38.0 -- sh -c 'cat /etc/resolv.conf'
# search default.svc.cluster.local svc.cluster.local cluster.local
# nameserver 10.43.0.10
# options ndots:5
```

Observe that CoreDNS is `10.43.0.10` and that the same query from the `default` namespace for
the bare name `cartservice` returns `NXDOMAIN` — cross-namespace names require the FQDN.

**4. Inspect the LoadBalancer implementation.**

```bash
kubectl get svc frontend-external -n online-boutique -o wide
kubectl get ds -n kube-system | grep svclb
```

```text
NAME                TYPE           CLUSTER-IP    EXTERNAL-IP   PORT(S)        AGE    SELECTOR
frontend-external   LoadBalancer   10.43.47.17   172.17.0.4    80:32597/TCP   145m   app=frontend

NAME                               DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR   AGE
svclb-frontend-external-90c9bfcd   1         1         1       1            1           <none>          144m
```

Observe the k3s ServiceLB DaemonSet (`rancher/klipper-lb:v0.4.13`) that makes the
LoadBalancer real on this node, and how its name embeds the Service name and a hash. Kill the
svclb pod and watch the DaemonSet recreate it.

**5. Reach the shop through a tunnel.**

```bash
kubectl port-forward -n online-boutique svc/frontend-external 8080:80
# in another terminal:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080
```

```text
200
```

Observe: `localhost:8080` — the host's port — delivers a 200 from the frontend pod.
`172.17.0.4` (the Docker bridge) is not routable from the host the way a public LB would be,
so the tunnel is how this lab environment reaches the shop; always kill the background
`port-forward` when you are done.

## Common Pitfalls

- **Using a pod IP in `*_ADDR`.** Pod IPs change on every restart; Service names do not.
  If you hand-edit `CART_SERVICE_ADDR` to `10.42.0.17:7070` it works for five minutes, then
  turns the moment the pod moves. Never hard-code pod IPs.
- **The short-name NXDOMAIN trap.** `cartservice` resolves only in `online-boutique`. From
  `default` (or any other namespace) use the full FQDN
  `cartservice.online-boutique.svc.cluster.local`, or deploy the probe pod with `-n`.
- **`getent` not found in busybox.** Some `busybox:1.38.0` builds omit the `getent` applet
  (verified here). Prefer `nslookup <fqdn>` or inspect `/etc/resolv.conf`; the shells behave
  the same for the DNS answer.
- **Confusing `port` and `targetPort`.** Callers use `port` (`emailservice:5000`); pods serve
  `targetPort` (8080). Get it backwards and the Service will show READY pods but time out.
- **Expecting EXTERNAL-IP to be public.** `172.17.0.4` is the Docker bridge, not a routable
  address. Without a real cloud LB or ingress, use `port-forward`. On AWS EKS the provider
  creates the ELB; here k3s ServiceLB only announces the node IP.
- **Editing an existing Service's `type` live** — handy for the LoadBalancer->ClusterIP demo,
  but remember each change makes the ServiceLB DaemonSet appear/disappear; give it a few
  seconds before probing endpoints.
- **Forgetting NodePort's range.** `32597` is k3s's auto-picked high port (30000-32767).
  Trying to force port 80 as a NodePort will be rejected; that is why LoadBalancers keep a
  separate `nodePort`.

## Key Takeaways

- Every pod has a cluster-private IP (`10.42.0.0/16` here); pod IPs are ephemeral, so apps
  address Services, never pods.
- A Service is selector -> Endpoints/EndpointSlice -> kube-proxy DNAT rules fanning out to
  ready pods; `kubectl get endpoints` shows the fan-out live.
- The shop uses ClusterIP for internal traffic, LoadBalancer for the single public door, and
  NodePort (`80:32597/TCP`) as the LoadBalancer's plumbing on every node.
- On k3s there is no cloud controller: ServiceLB (`svclb-frontend-external-*`, klipper-lb)
  binds node port 32597 and announces the node's Docker-bridge IP `172.17.0.4`.
- CoreDNS at `kube-dns` (`10.43.0.10`) resolves `<svc>.<ns>.svc.cluster.local`; short names
  work only inside the same namespace (`ndots: 5` search domains).
- gRPC needs no special k8s machinery (it is just TCP) but connection reuse over HTTP/2
  reshapes how loads concentrate across replicas.

## Review Questions

1. Why does the frontend's code talk to `cartservice:7070` instead of to a pod IP? What
   breaks if you demand it use a pod IP instead?
2. What three objects/stages sit between "the selector in a Service" and "a connection being
   forwarded to a running pod"? Which command shows the result of stage two?
3. `frontend-external` reports `80:32597/TCP`. If you were on AWS EKS, what would you use
   that NodePort for, and what creates the EXTERNAL-IP there vs. on `dev-cluster`?
4. A pod in the `default` namespace queries `cartservice` and gets `NXDOMAIN`. Explain
   exactly why, end to end, naming the FQDN and the search domains.
5. What port is `kube-dns` on, and what do the three values in a pod's `/etc/resolv.conf`
   (`search`, `nameserver`, `options ndots:5`) each control?
6. gRPC services listen on port 50051. The Service is `ClusterIP`. Kube-proxy has no gRPC
   awareness. Why does the shop still work, and what gRPC-specific behavior should an
   operator watch for?

### Answers

1. Because pod IPs are ephemeral: restart, reschedule, or a rolling update changes them.
   Hard-coding a pod IP produces a configuration that silently breaks the next time that pod
   is replaced; Service names resolve consistently regardless of pod churn.
2. Endpoints/EndpointSlice (written by the endpoints controller) and kube-proxy's
   iptables/IPVS rules (built from those endpoints). The result of stage one/two inspection
   is `kubectl get endpoints frontend -n online-boutique` (e.g. `10.42.0.23:8080`).
3. On AWS EKS the NodePort is what the ELB forwards client traffic to; the cloud controller
   provisions the ELB and writes its address into `EXTERNAL-IP`. On `dev-cluster`, k3s
   ServiceLB (klipper in a `svclb-*` DaemonSet) binds the node port and advertises the
   Docker-bridge IP `172.17.0.4` instead.
4. `cartservice` is not an FQDN (`ndots:5` forces search-domain appends). From `default`,
   CoreDNS tries `cartservice.default.svc.cluster.local`,
   `cartservice.svc.cluster.local`, and `cartservice.cluster.local` — none exist, so it
   returns NXDOMAIN. The FQDN `cartservice.online-boutique.svc.cluster.local` resolves to
   `10.43.232.151`.
5. Port 53 (UDP and TCP, plus 9153 for metrics). `nameserver` is the resolver to query
   (`10.43.0.10`, CoreDNS); `search` lists suffixes appended to bare names in order; `ndots`
   is the dot-count threshold below which suffixes are appended first.
6. gRPC tunnels over HTTP/2, which tunnels over TCP, so kube-proxy's TCP DNAT handles it
   with no special support. Watch out: HTTP/2 reuses one long-lived connection per client, so
   connection-level balancing can skew load to one replica; robust clients must re-resolve and
   reconnect as pods are drained.