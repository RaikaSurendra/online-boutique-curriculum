---
layout: module
title: "Module 10: Tooling & CI/CD"
slug: 10-tooling-cicd
meta:
  part: Part IV — Operations
  subtitle: kubectl, helm, skaffold, kustomize, port-forward, automation
---

# Module 10: Tooling & CI/CD

## Learning Objectives

By the end of this module you will be able to:

- Use kubectl's power output modes (`-o wide/yaml/jsonpath`), selectors (`-l`), and the
  `--dry-run=client -o yaml | kubectl apply -f -` pattern to generate and inspect manifests
  without touching the cluster.
- Walk through `onlineBoutique/scripts/` as a real, repeatable delivery pipeline and explain
  how each script maps to a CI/CD stage.
- Explain why idempotent, rerunnable scripts are the essence of infrastructure as code.
- Define Helm, Kustomize, Skaffold, and Terraform, say when each is the right tool, and
  recognize which ones the upstream project already ships.
- Use `kubectl port-forward` to reach a cluster-only service from localhost through the API
  server.
- Run the project's smoke-verify and dry-run workflows and observe their output.

## Prerequisites

- Module 04 (deployment scripts, the 980-line manifest).
- Module 07 (the `floci-eks` named AWS profile).
- Module 08 (push flow, `IfNotPresent` caching).

## Time estimate

Lecture: 60 min, Lab: 45 min.

## Concepts

### kubectl power features, a tour

Throughout the course you have used `kubectl get pods -o wide`, but kubectl's output engine
deserves explicit attention, because every pipeline in this course leans on it.

- `-o wide` -- one row per object, extra columns that the table form hides (READY, STATUS,
  RESTARTS, AGE, IP, NODE, READINESS GATES for pods; TYPE, CLUSTER-IP, EXTERNAL-IP, PORT(S)
  for services).
- `-o yaml` -- the object as raw YAML, exactly what the cluster stores. Round-trip it:
  `kubectl get deploy frontend -n online-boutique -o yaml | head` to inspect defaults the
  manifest never mentioned (imagePullPolicy, readiness gates, container images).
- `-o jsonpath='...'` -- extract a single field across every object, the basis for loops and
  conditionals:

  ```bash
  kubectl get deploy -n online-boutique -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
  ```

  which prints the twelve deployment names one per line. The JSONPath expression reads
  "for each item in the list, print `.metadata.name` then a newline".
- Selectors `-l key=value` -- pick objects by label instead of maintaining name lists;
  k3s applies the same filter syntax to `get`, `logs`, `scale`, and `delete`.
- `--dry-run=client -o yaml | kubectl apply -f -` -- the canonical "build a manifest on the
  fly and apply it" idiom. The left side generates YAML without contacting the cluster; the
  right side applies it to the cluster. `04-deploy.sh` uses exactly this to create the
  namespace:

  ```bash
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  ```

  `--dry-run=server` on the right side lets you validate ("what WOULD this change?") without
  committing. Combined, these give you full declarative control from scripts.
- `--field-selector=...` -- filter result objects by a field condition (k3s extension), e.g.
  `kubectl get pods -n online-boutique --field-selector=status.phase=Running` to list only
  running pods.

### The project's shell automation as a delivery pipeline

CI/CD (continuous integration / continuous delivery) is nothing more than turning your manual
`build -> test -> deploy -> verify` ritual into repeatable, scripted steps that a server runs
for you. This project already is such a pipeline: `onlineBoutique/scripts/` contains the eight
stages in order. Read them as a pipeline, not as "a bunch of shell files".

**`00-env.sh` -- pipeline parameters (single source of truth).** Every other script sources it.
It defines the variables that parameterize the whole delivery: `AWS_PROFILE=floci-eks`,
`CLUSTER_NAME=dev-cluster`, `NAMESPACE=online-boutique`, `ECR_REGISTRY=...localhost:4566`,
`IMAGE_TAG=v0.10.7`, `ECR_REPO_PREFIX=microservices-demo`, `UPSTREAM_REPO` and `UPSTREAM_TAG`,
and the ordered `SERVICES` list. Change one variable and every downstream stage follows; this
is the same idea as a CI system's environment variables / build matrix.

**`01-fix-eks-auth.sh` -- reconcile stage.** Idempotent: it first tests
`aws sts get-caller-identity` and `kubectl get nodes`; if both already work it prints the node
list and exits 0. Otherwise it repairs: create IAM user `eks-admin`, attach
`AdministratorAccess`, mint an access key, write the named `floci-eks` profile, regenerate the
kubeconfig. Re-running it is the definition of safe. This is *infrastructure as code* (IaC):
state is declared in code and any drift gets reconciled back.

**`01-fix-floci-network.sh` -- reconcile stage (networking).** Same philosophy for the ECR
data plane: ensure `floci-net` exists, attach `floci`, `floci-ecr-registry`, and
`floci-eks-dev-cluster`, verify `docker login` and `curl /v2/` return 200. Safe to run at any
time; repeated runs are no-ops (see Module 08).

**`02-clone-upstream.sh` -- dependency pinning.** Clones
`GoogleCloudPlatform/microservices-demo` at the pinned tag `v0.10.7` (shallow, `--depth 1
--branch`). If already cloned, it re-fetches the tag and checks it out. Builds never silently
track `main`; the exact upstream commit is a build input, which is how reproducible pipelines
must treat third-party sources.

**`03-build-push-images.sh` -- build + push stage.** For each service: idempotent
`aws ecr create-repository`; `docker buildx build --platform linux/arm64 ...` from the
upstream Dockerfile; `docker push` to the Floci registry; and the crucial cache eviction
(`crictl rmi`) so k3s re-pulls the changed tag (Module 08). It honors a `SERVICES="frontend
emailservice"` environment override to build a subset, and `PARALLEL:=2` to cap concurrency --
exactly the knobs a CI job would expose as build parameters.

**`04-deploy.sh` -- deploy stage.** With `--rebuild-manifest` it regenerates the manifest with
`sed`, rewriting upstream image refs
`us-central1-docker.pkg.dev/.../microservices-demo/<svc>` into
`000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/<svc>` (a deterministic,
scripted version of "edit this one file"). It then creates the namespace via the dry-run/apply
idiom, `kubectl apply -f` the manifest, and waits per Deployment with
`kubectl rollout status --timeout=5m`, tolerating transient failures with `|| true`. This is
the "apply and wait for convergence" pattern every deploy pipeline needs.

**`05-verify.sh` -- smoke test stage.** Prints pods (`-o wide`), services, a `kubectl top pods`
resource pulse, then opens a `kubectl port-forward` to `frontend-external` and curls it,
checking `HTTP 200` and the page title. (Small real-world wart: under `set -u` the
port-forward line can print `line 21: $!: unbound variable`; the pods/services/top output is
unaffected -- a good reminder that even production scripts ship with cosmetic defects, and
"does my CI step actually fail" beats "is it pretty".) A stage that tests the artifact end to
end before you call the deploy done.

**`99-cleanup.sh` -- teardown stage.** Deletes the namespace (`--ignore-not-found`), plus with
`--ecr` deletes every ECR repository with `--force`. Teardown being a first-class script is
what makes this lab environment reproducible for the next student.

```
 00-env    01-fix-*     02-clone    03-build   04-deploy   05-verify   99-cleanup
 params    reconcile    pin deps    push       apply+wait  smoke test  teardown
                                              ~------------------------------->
                                                    CI/CD stage map
```

### Why this maps to CI/CD

Each script is a *stage*: parameterize (`00`), reconcile credentials (`01`), fetch a pinned
dependency (`02`), build and push artifacts (`03`), deploy (`04`), verify (`05`), clean up
(`99`). Put a runner between them and you have a pipeline: in Jenkins or GitHub Actions, the
same eight scripts would be eight steps in a workflow file, with two substitutions:

1. **Secrets swap.** `01-fix-eks-auth.sh` bakes a profile into `~/.aws`; in CI, the AWS
   access key and secret come from the runner's secret store (environment variables or
   `credential_helpers`), not from a profile file, and nothing is ever committed to git.
2. **Idempotency becomes the contract.** Every script must be rerunnable without damage,
   because CI re-runs interrupted jobs. That is why `|| true`, `--ignore-not-found`, and the
   *[ ]* "already on network / already authenticated" guards appear everywhere: they are not
   laziness, they are the IaC design rule "the same input converges to the same state".

When your course capstone says "run the pipeline", a single
`scripts/03-build-push-images.sh && scripts/04-deploy.sh && scripts/05-verify.sh` invocation
is already a minimal CD run, hands-free.

### Other tools in the ecosystem

Four names come up constantly in Kubernetes job postings. You do not run any of them in this
course; you learn what each is for so you recognize the pattern when you meet it.

**Helm -- chart packaging.** Helm packages Kubernetes manifests as *charts* (a directory of
templates plus a values file) with versioning, dependencies, and `helm install`/`helm upgrade`
lifecycle commands. You would use Helm once a deployment grows past a handful of environments
and you want one chart, many environment overrides. Upstream ships `helm-chart/` in this very
repo -- the intent is `helm install microservices-demo ./helm-chart --set image.tag=v0.10.7`
to deploy the shop on any cluster from a parameterized chart. (Reference only; this course
applies the raw manifest.) More on this later in your career, not now.

**Kustomize -- declarative overlays.** Kustomize is a templating system that kubectl has
built in (`kubectl kustomize`); you keep a `base.yaml` and drop-in *overlay* files that patch
it per environment (dev vs prod), then render one merged manifest. You would use it when
one manifest with small per-environment deltas beats editing five near-identical files.
Upstream ships a `kustomize/` set exactly for that: one base and overlays that tweak a few
fields per target. Tools like `sed` in `04-deploy.sh` are the 90%-solution, and Kustomize is
the structured 100%-solution for the same problem.

**Skaffold -- the developer inner loop.** Skaffold watches your source tree and turns
`code change -> rebuild image -> push -> redeploy` into one command, so you can iterate on a
running cluster the way you iterate locally (`skaffold dev`). The upstream repo ships a
`skaffold.yaml` whose entire job is "build the shop images, deploy them to whatever kubectl is
pointing at, repeat on save". This is the tool you reach for during feature development; the
scripts in this course do the same loop, just less incrementally.

**Terraform -- infrastructure as code for cloud resources.** Terraform declares cloud
resources (VPCs, subnets, EKS clusters, registries) in HCL files and converges real state to
the declared state (`terraform plan`/`apply`). Floci, in fact, emulates exactly these AWS
resources, so here you practice the targets without paying for them; on real AWS you would use
Terraform to declare the cluster and ECR that this course stands up for free. Upstream ships a
`terraform/` module set for provisioning the cloud backing network -- the same idea as
`eksSetup/scripts/setup-eks.sh`, but declarative and platform-neutral.

Rule of thumb: Helm for packaging, Kustomize for per-env overlays, Skaffold for the dev loop,
Terraform for the cloud platform itself. They overlap, and real teams pick two.

### `kubectl port-forward`: local access through the API server

The shop's real URL is only reachable from inside the cluster (`frontend` is ClusterIP;
`frontend-external` is a LoadBalancer that on Floci stays Pending with no external listener).
To browse from your laptop, kubectl tunnels a local port through the control plane:

```bash
kubectl port-forward -n online-boutique svc/frontend-external 8080:80
```

Then in another terminal:

```bash
curl http://localhost:8080    # -> the shop's HTML, HTTP 200
```

How it works: kubectl opens a port on your machine, connects to the API server / kubelet on
the node, and asks the pod to accept the connection from the node side; bytes are streamed
back over that control-plane tunnel. From the pod's point of view a client inside the cluster
connected to the service. This is why `05-verify.sh` can smoke-test the shop with plain
`curl` regardless of the LoadBalancer's Pending state. Close it with Ctrl-C; on macOS set the
tunnel to background `&` and remember its PID when you want to stop it.

## Hands-On Lab

All commands are real. Run them from the repo root
(`/Users/.../floci-microservices-online-boutique`).

```bash
# 1. The pipeline's parameter hub
source onlineBoutique/scripts/00-env.sh && echo "$ECR_REGISTRY $IMAGE_TAG $NAMESPACE"
# -> 000000000000.dkr.ecr.us-east-1.localhost:4566 v0.10.7 online-boutique
```

Observe the single source of truth: every script will now inherit these exact values.

```bash
# 2. JSONPath extraction: deployment names as data
kubectl get deploy -n online-boutique -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
```

Observe twelve names, one per line (adservice, cartservice, checkoutservice,
currencyservice, emailservice, frontend, loadgenerator, paymentservice,
productcatalogservice, recommendationservice, redis-cart, shippingservice). Note how this
output is machine-ready: `04-deploy.sh` feeds it to the rollout loop.

```bash
# 3. The smoke-test stage end to end
onlineBoutique/scripts/05-verify.sh
```

Observe the four sections: `=== Pods ===` (READY 1/1, Running), `=== Services ===`
(ClusterIP entries plus `frontend-external LoadBalancer`), `=== Resource usage ===`
(`kubectl top pods`), and the access section with a `curl -w "HTTP %{http_code} ..."` line.
If the port-forward block prints `line 21: $!: unbound variable`, that is the cosmetic defect
noted in Concepts -- pods/services/top already printed fine; the page-check needs the fix
below.

```bash
# 4. The generate-and-apply idiom, dry-run version (no cluster change)
kubectl create namespace dryrun --dry-run=client -o yaml | kubectl apply -f - --dry-run=server
```

Observe, in order: kubectl renders the namespace YAML client-side (no network), the right
side validates it against the server and reports `namespace/dryrun created (server dry run)`
without creating anything. Then clean up the concept cleanly:

```bash
kubectl delete ns dryrun --ignore-not-found
```

```bash
# 5. Idempotency, observed directly: re-run a reconcile script
onlineBoutique/scripts/01-fix-floci-network.sh
# ==> Ensuring floci-net exists and wiring Floci containers...
#   [ok]   floci already on floci-net
#   [ok]   floci-ecr-registry already on floci-net
#   [ok]   floci-eks-dev-cluster already on floci-net
# ...
#   OK: http://000000000000.dkr.ecr.us-east-1.localhost:4566/v2/ -> 200
```

Run it twice. The second run is a no-op from the cluster's point of view: same `[ok]` lines,
same `200`, world unchanged. That property, more than the commands themselves, is what makes
the scripts pipeline-safe.

```bash
# 6. (Optional) Wire the shipping smoke test yourself
kubectl port-forward -n online-boutique svc/frontend-external 8080:80 &
sleep 2
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:8080     # -> HTTP 200
kill %1
```

If you want a verbatim `$!`-free `05-verify.sh`, replace its line 21
(`(kubectl port-forward ... &) ; PF=$!`) with the direct form
`kubectl port-forward ... > /dev/null 2>&1 & PF=$!` and keep `set -u` happy.

## Common Pitfalls

- **Running the scripts without sourcing `00-env.sh` first.** Every script sources it, so
  direct execution is safe; the danger is coding new one-liners by hand with the values typed
  out. If a variable in a guide mismatch a script, diff against `00-env.sh` first.
- **Treating the `$!` message in `05-verify.sh` as a failure.** It is a shell-scoping wart
  (`$!` unset after a subshell under `set -u`) in the port-forward block; the pods/services/
  top sections have already printed. Fix the line or background the tunnel manually.
- **Editing the manifest by hand instead of `--rebuild-manifest`.** The `sed` rewrite is
  deterministic and was proven against every upstream ref; your handwritten substitute will
  diverge. Regenerate, do not mutate.
- **Committing real AWS credentials.** The named `floci-eks` profile lives only in
  `~/.aws/credentials`; in CI, keys come from secret stores via environment variables.
  A repository is not a place for `.aws` or build logs containing `AWS:` tokens.
- **Pushing under the same tag and expecting pods to change (repeat of Module 08).** The
  pipeline's `crictl rmi` eviction exists precisely because `IfNotPresent` will not re-pull;
  if you hand-push, hand-evict too.
- **Confusing `kubectl get events` with application logs.** Events are cluster lifecycle
  (scheduling, probes, load-balancer ensuring); application output lives in `kubectl logs`.
  Consult both, in that order.

## Key Takeaways

- kubectl's output engine (`-o`, selectors, `--dry-run=client -o yaml | kubectl apply -f -`)
  lets scripts treat the cluster as a declarative API instead of a click-surface.
- `onlineBoutique/scripts/` is a real pipeline: params -> reconcile -> pin -> build/push ->
  deploy -> verify -> teardown. Read and re-run it as such in the capstone.
- Idempotency and rerunnability are the defining properties of infrastructure-as-code scripts,
  and every `|| true`, `--ignore-not-found`, and `[ok]` guard in this repo exists to buy them.
- Helm (packaging), Kustomize (overlays), Skaffold (dev loop), and Terraform (cloud platform)
  are the production-grade siblings of the mechanisms this course uses directly; upstream
  ships examples of all four.
- `kubectl port-forward` tunnels a local port through the control plane to a pod, giving you
  localhost access to cluster-internal services and making smoke tests plain `curl`.
- The same scripts become CI steps by swapping profile-based credentials for environment
  secret handling -- everything else already runs headlessly.

## Review Questions

1. In `04-deploy.sh`, what does
   `kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -` do in
   two halves, and why is that better than a hardcoded `kubectl apply` of a hand-written file?
2. Explain the JSONPath expression
   `{range .items[*]}{.metadata.name}{"\n"}{end}` in one sentence, and one thing a script can
   now do with its output.
3. Which two scripts are "reconcile" scripts, and what would be the symptom if their
   idempotency guard (`sts get-caller-identity`, `docker network inspect`) were missing?
4. Map each of `02-clone-upstream.sh`, `03-build-push-images.sh`, `04-deploy.sh`, and
   `05-verify.sh` to its CI/CD stage name.
5. Why does `kubectl port-forward svc/frontend-external 8080:80` reach the shop even though
   the LoadBalancer service shows Pending on Floci?
6. You run `scripts/01-fix-floci-network.sh` twice. Describe the two behaviors you observe
   that prove it is idempotent, and name the tool category ("infrastructure ...") that
   requires this property.

### Answers

1. The left half renders the namespace manifest on the client (`--dry-run=client`) with no
   network call; the right half declaratively applies that generated YAML. Splitting them this
   way keeps a single source of truth (the namespace variable) and lets the same idiom handle
   any object, instead of maintaining separate apply files.
2. It iterates over every Deployment in the namespace and prints each object's name followed
   by a newline, producing a plain list. A script can pipe it into a loop (as
   `04-deploy.sh` does for `kubectl rollout status`) or into any shell data handling.
3. `01-fix-eks-auth.sh` and `01-fix-floci-network.sh`. Without the guards, every run would
   recreate the IAM user/key or duplicate the network attach (Docker errors with "endpoint ...
   already exists in network"), making the pipeline non-rerunnable.
4. `02` pins the dependency (fetch), `03` builds and pushes the artifact (build/push),
   `04` applies and waits for convergence (deploy), `05` curls the frontend and checks HTTP
   200 (smoke test/verify).
5. The LoadBalancer's cluster-side state is irrelevant to the tunnel: `kubectl port-forward`
   streams through the API server to the pod that backs the service, so from the pod's
   perspective a client inside the cluster connected; only loopback on your laptop is exposed.
6. Both runs print the same `[ok]` lines and the `curl /v2/` check returns `200` with no
   state change on the second pass -- the script converges to "already done". The category is
   *infrastructure as code*, whose contract is that rerunning converges to the same declared
   state.