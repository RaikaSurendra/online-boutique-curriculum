---
layout: module
title: "Module 00: Getting Started"
slug: 00-getting-started
meta:
  part: Part I — Foundations
  subtitle: Environment, tools, and the big picture
---

# Module 00: Getting Started

## Learning Objectives

- By the end of this module you will be able to explain what the course builds and describe the
  final running system (the shop, the cluster, and the emulator that hosts both).
- By the end of this module you will be able to name every tool in the toolchain — Docker Desktop,
  the aws CLI, kubectl, git, and your shell — and say in one sentence what each one is for.
- By the end of this module you will be able to navigate the two halves of the lab repository
  (`eksSetup/` and `onlineBoutique/`) and say which scripts bootstrap the cluster and which build
  and deploy the shop.
- By the end of this module you will be able to read the big-picture architecture diagram and trace
  a `kubectl` command, a `docker push`, and a browser request to the container that serves them.
- By the end of this module you will be able to run a small set of verification commands
  (`docker ps`, `kubectl get nodes`, `kubectl get pods`) and judge from their output whether the
  course environment is healthy.

## Prerequisites

None — this is the first module. Before you begin, skim the syllabus in `../README.md` so the rest
of the course has a map. You will also need the one-time setup described in the syllabus ("Getting
the lab environment"): cloning the lab repository and running `eksSetup/scripts/setup-eks.sh`, which
bootstraps the cluster. This module assumes that script has already run once and that you are doing
the verification pass.

## Time estimate

Lecture: 45 min, Lab: 30 min.

## Concepts

### What this course builds

This course takes a production-shaped microservices application — Google's *Online Boutique*
(`GoogleCloudPlatform/microservices-demo`, pinned at tag `v0.10.7`) — and deploys it to a
Kubernetes cluster that runs entirely on your laptop. The shop is eleven services written in five
languages (Go, .NET, Java, Node.js, Python) plus a Redis cache used by the cart, which together
form twelve *deployments*. A browser tab pointed at the frontend port shows a real, working
storefront: a product catalog, a shopping cart, checkout, shipping, advertisements, a payment
service, and an email service that "sends" receipts.

What makes the course interesting is not the storefront itself but *where it runs*. The cluster is
not a toy. It is a *k3s* cluster — the real Kubernetes distribution — created and managed by an AWS
emulator named *Floci*. To Kubernetes, and to your `kubectl` client, that cluster is
indistinguishable from a real Amazon EKS cluster. So every concept you learn here — namespaces,
Deployments, Services, IAM-style authentication, container registries, image pull failures —
transfers directly to a production cloud cluster.

By the end of the course you will have: bootstrapped the emulated EKS environment yourself, built
every image for the correct CPU architecture, deployed all twelve applications, watched them serve
traffic, observed and load-tested them, broken and fixed them, and cleaned everything up.

### How to work through the course

Every module in this curriculum follows one shape, so after this first read each one will feel
familiar: a set of *Learning Objectives*, the earlier modules you need, a time budget, the
*Concepts* (theory, built bottom-up with inline definitions), a *Hands-On Lab* (real, runnable
commands tied to the project scripts), *Common Pitfalls*, *Key Takeaways*, and *Review Questions*
with answers. Terms are defined in italics the first time they appear; cross-references look like
`Module 08 -> ECR & Container Registries` so you always know where a topic is revisited.

Two navigation rules save time later:

1. The lab commands are always the *real* commands from this project. When a section says "run
   `scripts/03-build-push-images.sh`", open that script and read it alongside the prose — the
   scripts are part of the reading material, not just something to execute.
2. The artifacts everything refers to are `eksSetup/scripts/setup-eks.sh`,
   `eksSetup/Error_Documentation.md`, `onlineBoutique/scripts/*.sh`, and
   `onlineBoutique/manifests/kubernetes-manifests.yaml`. Keep those four files in reach.

### The toolchain at a glance

Everything we run on the host machine is a short list of well-known command-line tools. Do not
install anything beyond this list — every later module adds zero new host software.

| Tool | What it is | Why we need it in this course |
|---|---|---|
| Docker Desktop | The container engine plus image-building tooling (`docker buildx`) for macOS | The entire course runs in containers: the AWS emulator, the Kubernetes cluster, the registry sidecar, and every service image you build. On Apple Silicon it runs arm64 images natively and can emulate amd64 via Rosetta 2. |
| aws CLI (v2) | Amazon's official AWS command-line client | We point it at Floci's local endpoint (`http://localhost:4566`) so we can run real AWS commands — `aws eks create-cluster`, `aws ecr create-repository`, `aws configure` — against the emulator instead of the cloud. |
| kubectl (~1.28+) | The Kubernetes command-line client | It talks to the cluster's API server on port 6500 to create, read, and verify everything that runs in the cluster (pods, services, nodes). |
| git | Distributed version control | Used to clone the lab monorepo and to check out the upstream Online Boutique code at exactly tag `v0.10.7`. |
| bash / zsh | Your shell | All course scripts (`00-env.sh`, `03-build-push-images.sh`, and the rest) are bash scripts you will read, source, and re-run. |

The mental model is three layers talking to one another: the shell scripts drive the `aws` and
`kubectl` CLIs; those CLIs hit local endpoints owned by Docker; and Docker runs the containers that
do the real work. A quick sanity list for the versions this course expects:

- Docker Desktop with the `docker` CLI on PATH (Apple Silicon native, Rosetta 2 enabled for x86).
- aws CLI v2 (`aws --version` prints `aws-cli/2.x ...`). The `aws` config lives in
  `~/.aws/`; the named profile `floci-eks` is created for us and used with `--profile floci-eks`.
- kubectl `1.28+` (`kubectl version --client`).
- git, plus `bash` as the interpreter the scripts require (they are `#!/bin/bash`; zsh users just
  run them as scripts or with `bash <script>`).

### The repository layout

You will work inside one monorepo, `floci-microservices-online-boutique`, which contains two
independent halves. The first half (supplied) creates the cluster; the second half (exercised by
you) builds and deploys the shop.

```
floci-microservices-online-boutique/
├── eksSetup/                         # 1. cluster bootstrap (run once)
│   ├── scripts/
│   │   └── setup-eks.sh              # starts Floci, creates dev-cluster, wires kubectl
│   ├── Error_Documentation.md        # every real bug this environment hit, and its fix
│   └── SETUP_SUMMARY.md              # what setup-eks.sh does, step by step
└── onlineBoutique/                   # 2. the shop: images + deployment (your lab)
    ├── scripts/
    │   ├── 00-env.sh                 # shared env: AWS_PROFILE=floci-eks, registry, tag, services
    │   ├── 01-fix-eks-auth.sh        # idempotent: kubectl auth via IAM profile floci-eks
    │   ├── 01-fix-floci-network.sh   # idempotent: wires floci-net so ECR pushes work
    │   ├── 02-clone-upstream.sh      # clones microservices-demo @ v0.10.7
    │   ├── 03-build-push-images.sh   # builds all images for linux/arm64, pushes to Floci ECR
    │   ├── 04-deploy.sh              # applies the manifest, watches rollouts
    │   └── 05-verify.sh              # pods/services/top + port-forward + HTTP probe
    ├── manifests/
    │   └── kubernetes-manifests.yaml # the 980-line release manifest, image refs rewritten to ECR
    └── microservices-demo/           # upstream clone (created by script 02, gitignored)
```

Roughly: `eksSetup/` answers "how do I get a real Kubernetes cluster on my laptop?", while
`onlineBoutique/` answers "how do I build the right binary for this cluster and get it running?".
You will spend most of the course in `onlineBoutique/`.

### One diagram: everything at once

Here is the whole course environment on a single screen. It is worth returning to this diagram at
the start of every later module.

```
                        your Mac (Apple Silicon)
   Docker Desktop  (the container engine)
   +--------------------------------------------------------+
   |  floci   (AWS emulator, API on :4566)                 |
   |  +----------------------------+  +------------------+ |
   |  | dev-cluster                |  | floci-ecr-       | |
   |  |   k3s real-mode cluster    |  | registry (registry| |
   |  |   Kubernetes API on :6500  |  |  :2 ECR sidecar)  | |
   |  |   one arm64 node 64ee2f5.. |  |  image storage    | |
   |  |   runs ALL shop pods       |  |                   | |
   |  +----------------------------+  +------------------+ |
   |                         ^        |                    |
   |            spawned & supervised by floci               |
   +--------------------------------------------------------+

   aws / kubectl    ----:4566----> floci          (AWS + EKS control plane)
   docker push      ----:4566----> floci ECR proxy --> sidecar   (container data plane)
   browser          --> frontend pod inside dev-cluster          (the shop)
```

Three containers matter most, and you will recognize them by name:

- `floci` — the AWS emulator. It listens on `http://localhost:4566`, speaks the AWS HTTP API, and
  on demand creates real backing containers for the AWS resources it emulates.
- `floci-eks-dev-cluster` — the Kubernetes cluster itself, named `dev-cluster`. Floci runs it as a
  k3s "real-mode" cluster: a single arm64 node that runs the actual Kubernetes control plane and
  schedules the shop's pods. Its API server is published on port 6500.
- `floci-ecr-registry` — a `registry:2` container that acts as the data store behind Floci's
  emulated ECR. Every image we build is pushed here and pulled by the cluster from here. The
  registry's public face is the loopback URI `000000000000.dkr.ecr.us-east-1.localhost:4566`.

### What "emulated EKS" actually means

Three glossaries before we verify anything:

- *EKS* (Amazon Elastic Kubernetes Service) is AWS's hosted Kubernetes product. In EKS, "the
  cluster" is a managed object: you ask AWS to create it, and AWS provisions nodes and an API
  endpoint for you.
- *Floci* is a free, open-source AWS emulator. It implements the AWS HTTP API offline so that the
  real `aws` CLI works unchanged against `http://localhost:4566` — no cloud account, no cost, no
  latency, and instant destruction when you want to start over.
- *k3s* is a lightweight distribution of Kubernetes that packages the control plane and a worker
  into one binary and one container. Floci uses k3s "real mode" for EKS, so `dev-cluster` is a real
  Kubernetes API server, not a simulation.

The practical consequence: your `.kube/config` names the cluster as
`arn:aws:eks:us-east-1:000000000000:cluster/dev-cluster`, and `kubectl` treats it exactly like a
cloud cluster. The only difference is that the "cloud" lives inside Docker on your own machine.

One more term you will use constantly: a *namespace* is a named walled-off region inside a
Kubernetes cluster for keeping objects from different applications separate. All course work lives
in the namespace `online-boutique`.

The twelve deployments that live in that namespace are the shop itself:

```
frontend               (Go, the storefront you open in a browser)
adservice              (Java, serves ads on the product pages)
cartservice            (.NET, keeps the user's cart, backed by redis-cart)
checkoutservice        (Go, places orders)
currencyservice        (Node.js, converts prices)
emailservice           (Python, "sends" the confirmation email)
loadgenerator          (Python, generates traffic with Locust)
paymentservice         (Node.js, processes payment)
productcatalogservice  (Go, serves the product catalog)
recommendationservice  (Python, recommends products)
shippingservice        (Go, gives shipping cost/time)
redis-cart             (Redis, the cart's data store)
```

Eleven application services plus a Redis cache equals the twelve deployments you will verify in the
lab below. A compact way to remember the ports and protocols involved is the architecture ASCII in
`../04-online-boutique-deep-dive.md`; for now, simply note that the frontend listens on port 8080
inside the cluster and is reached from the browser through a kubectl port-forward on your host.

## Hands-On Lab

In this lab you prove the environment is alive. Everything you check here is a precondition for
every later module, so if a command surprises you, stop and fix it before moving on.

### Step 1 — Clone the lab repository

If you have not already:

```bash
git clone https://github.com/RaikaSurendra/floci-microservices-online-boutique.git
cd floci-microservices-online-boutique
```

### Step 2 — Verify the toolchain

Each of these must succeed; each tells you one thing about your host.

```bash
docker info          # Docker Desktop is running and the daemon answers
aws --version        # aws CLI v2 is installed
kubectl version --client   # kubectl ~1.28+
git --version        # git present
```

`docker info` prints a wall of JSON/configuration. You mainly want it to exit 0 (no error) and to
show `Server Version`. If it fails with "Cannot connect to the Docker daemon", Docker Desktop is
not running — see Common Pitfalls.

### Step 3 — Confirm the emulated environment is up

First, the containers that should be running:

```bash
docker ps
```

Expect three long-running containers by these names: `floci`, `floci-ecr-registry`, and
`floci-eks-dev-cluster`. Their image columns should show `floci/floci:latest`, `registry:2`, and
the k3s node image. Observe the output: if any of the three names is absent, the environment was
not bootstrapped (re-run `eksSetup/scripts/setup-eks.sh`) or a container is down (check
`docker ps -a` and `docker logs <name>`).

Next, prove that `kubectl` can reach the cluster's API server and is authenticated:

```bash
kubectl get nodes
```

Expect exactly one node, named `64ee2f523cd3`, with status `Ready`, K3S-VERSION `v1.34.1`, and
OS-IMAGE `K3s`. The node runs on your Mac's CPU architecture (aarch64/arm64). A single Ready node
is the correct state for this course — "single node" is a design property of k3s, not an accident.
Observe the output: if you see "the server has asked for the client to provide credentials",
kubectl is not authenticating (AWS profile `floci-eks`, see Common Pitfalls).

Finally, look inside the namespace where the shop lives:

```bash
kubectl get pods -n online-boutique
```

Expect twelve pods, all `Running`: `adservice`, `cartservice`, `checkoutservice`,
`currencyservice`, `emailservice`, `frontend`, `loadgenerator`, `paymentservice`,
`productcatalogservice`, `recommendationservice`, `shippingservice`, and `redis-cart`. If you have
only just bootstrapped the cluster and have not yet deployed the shop (that happens with
`scripts/02-clone-upstream.sh`, `scripts/03-build-push-images.sh`, `scripts/04-deploy.sh`), this
command may instead return nothing or show only the sample nginx deployment; the twelve pods appear
once the shop is applied.

When all three checks pass, your machine is running: Docker Desktop on top, Floci emulating AWS on
port 4566, a real k3s `dev-cluster` exposing its API on port 6500, a registry sidecar ready for
image pushes (verified in Module 01's lab), and the Online Boutique shop serving inside the
cluster. You are ready for the rest of the course.

## Common Pitfalls

### Docker Desktop is not running

`docker info` fails with "Cannot connect to the Docker daemon". Start Docker Desktop (open the app
and wait for the engine, roughly 10 seconds), then re-run `docker info`. On Apple Silicon, also
confirm Rosetta 2 is enabled in Docker Desktop settings — the course builds native arm64 images,
but the emulator occasionally needs to run an x86 tool under emulation.

### kubectl points at the wrong cluster (or at nothing)

Every verification command fails even though Docker is healthy. Run:

```bash
kubectl config get-contexts
```

The current context (marked with a `*`) must be
`arn:aws:eks:us-east-1:000000000000:cluster/dev-cluster`. If the list is empty or the marker points
elsewhere, regenerate the kubeconfig:

```bash
aws eks update-kubeconfig --name dev-cluster --region us-east-1 --profile floci-eks
```

### The `floci-eks` AWS profile is not set

`kubectl get nodes` answers "the server has asked for the client to provide credentials". kubectl
authenticates through an exec credential plugin that signs a token with the IAM access key stored
in the AWS profile `floci-eks` (IAM user `eks-admin`). If that profile is missing or stale, the
token is rejected. Check the profile:

```bash
aws --profile floci-eks sts get-caller-identity
```

If it fails, recreate it with `onlineBoutique/scripts/01-fix-eks-auth.sh` (covered in
Module 07 -> IAM & EKS Authentication).

## Key Takeaways

- The course deploys the real Online Boutique (GoogleCloudPlatform/microservices-demo, tag
  `v0.10.7`) — eleven services plus Redis, twelve deployments — onto a real Kubernetes cluster
  running on your laptop.
- The host toolchain is exactly five things: Docker Desktop, aws CLI v2, kubectl ~1.28+, git, and
  your shell.
- `eksSetup/` bootstraps the cluster; `onlineBoutique/` builds and deploys the shop. All paths in
  this curriculum point at these two directories.
- Docker runs three long-lived containers: `floci` (AWS emulator, `:4566`), `floci-eks-dev-cluster`
  (k3s cluster `dev-cluster`, API on `:6500`), and `floci-ecr-registry` (registry:2 ECR sidecar).
- Healthy environment checks are `docker ps` (three named containers), `kubectl get nodes` (one
  Ready node `64ee2f523cd3`, k3s `v1.34.1`, arm64), and `kubectl get pods -n online-boutique`
  (twelve Running pods).
- The three classic failures — Docker down, wrong kubectl context, missing `floci-eks` profile —
  each have a single-line diagnostic and a single-line fix.

## Review Questions

1. What are the two top-level directories of the lab repository, and what job does each one do?
2. Name the three containers you expect from `docker ps` and give a one-line role for each.
3. Which port exposes the Floci AWS API, and which port exposes the k3s Kubernetes API?
4. What does `kubectl get nodes` prove, and what single node name and version do you expect?
5. The shop's images cannot be pulled ready-made from Docker Hub in this course. Why not? (Hint:
   think about the node's CPU architecture.)

### Answers

1. `eksSetup/` bootstraps the environment — it starts Floci, creates the EKS cluster `dev-cluster`
   backed by k3s, and wires up kubectl. `onlineBoutique/` holds the shop: scripts that build and
   push images and deploy the manifest, plus the manifest itself.
2. `floci` (the AWS emulator, API on `:4566`), `floci-eks-dev-cluster` (the k3s `dev-cluster`
   whose API server is on `:6500` and which runs the shop's pods), and `floci-ecr-registry` (the
   `registry:2` sidecar that stores the images we push and the cluster pulls).
3. Floci's AWS API is on `http://localhost:4566`; the k3s Kubernetes API server that kubectl talks
   to is on port 6500.
4. It proves kubectl can authenticate to and reach the cluster's API server. Expected: one node
   named `64ee2f523cd3`, status `Ready`, K3S-VERSION `v1.34.1`, OS-IMAGE `K3s`, on an arm64
   (aarch64) node.
5. The upstream project publishes images built for `linux/amd64`, but the k3s node (and your Apple
   Silicon Mac) is `aarch64/arm64`. We therefore build every image from source for the correct
   architecture. That is the entire subject of Module 01.