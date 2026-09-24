---
layout: module
title: "Module 01: Docker & Containers"
slug: 01-docker-containers
meta:
  part: Part I — Foundations
  subtitle: Images, layers, multi-stage builds, buildx, arm64 vs amd64
---

# Module 01: Docker & Containers

## Learning Objectives

- By the end of this module you will be able to explain, from first principles, the difference
  between a process, a virtual machine, and a container, and name the Linux mechanisms (namespaces,
  cgroups, union filesystems) that make containers lightweight.
- By the end of this module you will be able to read any Dockerfile — `FROM`, `WORKDIR`, `COPY`,
  `RUN`, `EXPOSE`, `ENTRYPOINT` vs `CMD`, `ARG` vs `ENV` — and explain what each instruction does
  and why it matters.
- By the end of this module you will be able to explain the multi-stage build pattern and point to
  the real examples in the project's Go, .NET, and Python service Dockerfiles.
- By the end of this module you will be able to explain image layers, why rebuilds with cached
  layers are fast, and how `docker buildx` reveals the layer list.
- By the end of this module you will be able to describe why the project builds every image for
  `linux/arm64`, how buildx auto args (`BUILDPLATFORM`/`TARGETPLATFORM`/`TARGETARCH`/`TARGETOS`)
  drive cross-architecture builds, and what went wrong with `cartservice`.
- By the end of this module you will be able to build, inspect, and verify the architecture of one
  real Online Boutique image using the exact commands from `03-build-push-images.sh`.

## Prerequisites

Module 00 -> Getting Started: your host tools (`docker`, `aws`, `kubectl`, `git`), the Floci
environment, and the lab monorepo must be in place. This module runs its lab on the `frontend`
service, so you also need the upstream clone produced by `onlineBoutique/scripts/02-clone-upstream.sh`.

## Time estimate

Lecture: 120 min, Lab: 90 min.

## Concepts

### From process to container

A *process* is simply an address space plus threads plus open files, managed by the operating
system. Your laptop runs hundreds of them already. The problem this course cares about is
*isolation*: if I run a program that writes a file at `/etc/config`, it overwrites the host's file.
If it binds to port 80, it fights every other program that wants port 80. Applications were never
meant to share one machine safely.

A *virtual machine* solves this by faking a whole computer on top of another computer: a hypervisor
presents virtual hardware, a full guest kernel boots inside it, and the guest operating system runs
unmodified. That is powerful but heavy — every VM drags around a kernel, and starting one costs
seconds and hundreds of megabytes.

A *container* takes the third path: just the *processes*, isolated by the host kernel itself. A
container is not a machine. It is a set of processes that live inside the host kernel but believe
they own the machine. The trick is done with two Linux mechanisms:

- *Linux namespaces* give a group of processes their own private view of the kernel. Three matter
  here:
  - **pid namespace** — inside a container, its main process is PID 1 (just like `init` on a booted
    OS), and it cannot see your other programs' PIDs.
  - **net namespace** — each container has its own network interfaces, IP address, and routing
    table, so two containers can both use port 80 without colliding.
  - **mount namespace** — each container has its own view of the filesystem tree; the container
    sees its own `/usr`, `/etc`, and `/proc`, not the host's.
- *cgroups* (control groups) are how the kernel *accounts* for and *limits* resource use. Docker
  puts a container's processes in a cgroup so it can measure CPU, memory, and I/O, and enforce
  limits like `--memory` or `--cpus`.

The outcome is worth stating sharply:

```
    process              container            virtual machine
  +----------+       +-------------+       +---------------+
  | 1 program|       | few programs|       | full OS        |
  | shares   |       | shares host |       | guest kernel   |
  | host OS  |       | kernel only |       | virtual hw     |
  | no       |       | namespaces  |       | hypervisor     |
  | isolation|       | + cgroups   |       | slow start,big |
  +----------+       +-------------+       +---------------+
```

A container is `pid` + `net` + `mnt` namespaces and a cgroup, applied to ordinary processes. That
is why containers start in milliseconds and weigh megabytes. It is also why a container only "has"
whatever the namespace gives it — installing a shell into an image is optional, a fact that will
matter for the distroless images below.

### Images: read-only layers plus a writable layer

If a container is the *running* process, an *image* is the *frozen instruction* for making one: the
filesystem, libraries, and program that the container needs. Docker stores an image as a stack of
read-only *layers* on top of a *union filesystem*. Each layer is a complete snapshot of the
filesystem *at the moment that step finished*; later layers only record the *changes* made after it.

```
          container (writable, per-process state)     <- copy-on-write top
   +----------------------------------------------------+
   |  3  COPY app files   (your code)                    |
   |  2  RUN install deps (build-time results) } image   |
   |  1  FROM base image  (starting FS)        } layers  |
   +----------------------------------------------------+
   |  image config: ENV / EXPOSE / ENTRYPOINT   (metadata)|
   +----------------------------------------------------+
```

When the container writes a file, the union filesystem does a *copy-on-write*: the original in the
read-only layer is left untouched and the change is recorded in the writable top layer. Three
consequences define how Docker feels in daily use:

1. Images are **shared**: two containers from the same image, or even two images that share `FROM
   python:...`, share every common layer on disk. No duplication.
2. Images are **immutable**: what was true when you built an image stays true forever — this is why
   pinning versions (as the project pins base images by digest) makes builds reproducible.
3. The build is **incremental**: a layer only rebuilds if the files it depends on changed. This is
   the entire basis of build caching, covered below.

### The Dockerfile: building images by recipe

A Dockerfile is a declarative recipe, one instruction per line, executed top to bottom by the
*build context* (the directory you pass as the last argument to `docker build`). Every line that
changes the filesystem becomes a layer.

| Instruction | What it does | Notes |
|---|---|---|
| `FROM <image>` | Names the base image (with tag and, in this project, a pinned digest) | The starter filesystem for the stage. Every Dockerfile has exactly one per stage. |
| `WORKDIR <dir>` | Sets (and creates) the working directory for later commands | `RUN`/`COPY`/`ENTRYPOINT` run relative to it. |
| `COPY <src> <dst>` | Copies files from the build context into the image | Only *this* stage's filesystem is changed; each `COPY` is one layer. |
| `RUN <cmd>` | Executes a command *at build time* and stores the result in the layer | This is where packages are installed and binaries are compiled. |
| `EXPOSE <port>` | Declares the port the program listens on | Documentation for humans and a hint for tooling; it alone does not publish a port. |
| `ENTRYPOINT` | The command executed when a container starts; arguments from `CMD` (or the CLI) are appended to it | Use for the "what this container runs" command. |
| `CMD` | Default arguments for `ENTRYPOINT`, or a fallback command if there is no `ENTRYPOINT` | Design convention: `ENTRYPOINT` fixed, `CMD` overridable (e.g. `CMD ["--port","8080"]`). |
| `ARG <name>` | A build-time variable, available only while the image is being assembled | Not present in the running container. Discard build secrets here. |
| `ENV <name>=...` | A runtime environment variable baked into the image | Visible to the running process. If a secret leaks into `ENV`, it leaks into the image. |

The mental shortcut: `RUN` builds *files*, `COPY` imports *files*, `ENV` passes values to the
process, and `ARG` passes values to the build. `ARG` and `ENV` look alike and are routinely
confused; the safe rule is "if the running program must see it, it is `ENV`; if only the Dockerfile
logic needs it, it is `ARG`."

### Multi-stage builds

A build often needs a fat toolchain — a Go compiler, the .NET SDK, a C compiler — to produce a
small artifact. Classic single-stage images shipped all of that garbage into production. The
*multi-stage build* fixes this: a Dockerfile contains several `FROM` lines, and only the *last*
stage becomes the final image. Earlier stages are `... AS builder`; the final stage copies only the
built artifact out of them with `COPY --from=builder ...`.

```
  stage 1: builder            stage 2: runtime (the shipped image)
  +---------------------+     +------------------------+
  | golang + sources    |     | distroless/static       |
  | RUN go build        |     | COPY --from=builder     |
  | produces /app/server| --> |   /app/server /server   |
  +---------------------+     | (no compiler, no shell) |
                              +------------------------+
```

The final image contains only what the program needs to *run*, which is dramatically smaller and
has a far smaller attack surface. Truthfully, the practical cost is that you can no longer
`docker exec` into the image to poke around — a point that bites every beginner once.

### The real Dockerfiles in this project

Open these files as you read this section: `onlineBoutique/microservices-demo/src/frontend/Dockerfile`
and the sibling Dockerfiles for the other services.

**Go services (frontend, checkoutservice).** Every Go service uses a two-stage build:

```dockerfile
ARG BUILDPLATFORM=linux/amd64

FROM --platform=$BUILDPLATFORM golang:1.27.0-alpine@sha256:4c9f...c46dbc AS builder
ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download
COPY . .

ARG SKAFFOLD_GO_GCFLAGS
RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} CGO_ENABLED=0 go build -ldflags="-s -w" -gcflags="${SKAFFOLD_GO_GCFLAGS}" -o /go/bin/frontend .

FROM gcr.io/distroless/static
WORKDIR /src
COPY --from=builder /go/bin/frontend /src/server
COPY ./templates ./templates
COPY ./static ./static

ENV GOTRACEBACK=single
EXPOSE 8080
ENTRYPOINT ["/src/server"]
```

Observations worth making out loud:

- The builder pins the Go toolchain *by digest* (`golang:1.27.0-alpine@sha256:...`), making the
  build reproducible. Docker refuses to silently swap a different image later.
- `COPY go.mod go.sum ./` comes *before* `COPY . .`. This is the cache-friendly order: dependency
  metadata changes rarely, code changes constantly, so the expensive `RUN go mod download` layer
  is nearly always served from cache. If the sources were copied first, every single code edit
  would invalidate the dependency layer and force a full re-resolve.
- The final stage is `gcr.io/distroless/static`. *Distroless* images contain no package manager,
  no shell, and often no users — just the binary and its minimal runtime. The `/static` variant is
  specifically for statically-compiled binaries, which is why the Go builder emits with
  `GOOS=${TARGETOS} GOARCH=${TARGETARCH}` (and why the exact ELF the final stage must run is a
  no-ceremony single file). Because there is no shell, the classic "let me exec in and look around"
  debugging move is impossible: you debug from logs.
- `ENTRYPOINT ["/src/server"]` is the whole container contract. The image is *only* the server
  binary plus static assets; everything else — compiler, linker, build cache — was strangled in the
  builder stage that never ships.

The `checkoutservice` Dockerfile is the same shape: `golang:1.27.0-alpine` builder, distroless
final stage, `EXPOSE 5050`, `ENTRYPOINT ["/src/checkoutservice"]`. Frontend merely starts a few
extra `COPY`s for `templates/` and `static/`.

**cartservice (.NET).** Dotnet ships a cross-compiler, so the builder can target another
architecture directly:

```dockerfile
ARG BUILDPLATFORM=linux/amd64

FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0.100-noble@sha256:c744...cd71 AS builder
ARG TARGETARCH=amd64
WORKDIR /app

COPY cartservice.csproj .
RUN dotnet restore cartservice.csproj -a $TARGETARCH
COPY . .
RUN dotnet publish cartservice.csproj \
    -p:PublishSingleFile=true \
    -a $TARGETARCH \
    --self-contained true \
    -p:PublishTrimmed=true \
    -p:TrimMode=full \
    -c release \
    -o /cartservice

FROM mcr.microsoft.com/dotnet/runtime-deps:10.0.0-noble-chiseled@sha256:b857...604

WORKDIR /app
COPY --from=builder /cartservice .
EXPOSE 7070
ENV DOTNET_EnableDiagnostics=0 \
    ASPNETCORE_HTTP_PORTS=7070
USER 1000
ENTRYPOINT ["/app/cartservice"]
```

Two details deserve attention. First, `dotnet publish -a $TARGETARCH --self-contained true` asks
the .NET toolchain to emit a *self-contained* binary for the target architecture — the runtime
libraries are bundled inside the single output, so the final image needs no .NET installation.
Second, the runtime base is *chiseled*: like distroless, a chiseled image is Ubuntu stripped to
exactly the packages a binary needs, again without a shell or package manager. The final stage
runs as `USER 1000` (a deliberately unprivileged user) — note that the builder stage never
declared `USER`, so it ran as root and had no reason not to.

**Python services (emailservice, loadgenerator).** Python has no compiler to cross-target, so the
build is "compile helpers on top of the runtime base, then copy the compiled site-packages into a
clean copy of the same base":

```dockerfile
ARG BUILDPLATFORM=linux/amd64

FROM --platform=$BUILDPLATFORM python:3.14.7-alpine@sha256:05b2...dcdc AS base

FROM base AS builder
RUN apk add --no-cache g++ linux-headers
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM base
RUN apk add --no-cache libstdc++
WORKDIR /email_server
COPY --from=builder /usr/local/lib/python3.14/ /usr/local/lib/python3.14/
COPY . .
EXPOSE 8080
ENTRYPOINT [ "python", "email_server.py" ]
```

Two `FROM` lines reference the same base, and the final stage copies only the installed
`site-packages` from the builder — build-only compilers (`g++`) stay in the builder. This is the
cheapest way to get a slim Python image: the heavy `pip install` layer is built once and the final
image is just the runtime base plus packages. Notice that `python:...-alpine` is an *Alpine* image
(musl libc, BusyBox shell); the final stage still has a shell, so `docker exec` debugging remains
possible here — the distroless Go images are the uncompromising case.

### Image layers and the build cache

Run the project's build and watch how a rebuild behaves. Because each Dockerfile instruction that
touches the filesystem is a layer, `docker buildx` can cache each completed layer. On a rebuild it
prints the step count and `CACHED` for everything untouched:

```
#5 [1/4] FROM golang:1.27.0-alpine@sha256:4c9f...  0.0s cached
#6 [2/5] COPY go.mod go.sum ./                      0.0s cached
#7 [3/5] RUN go mod download                        CACHED
#8 [4/5] COPY . .                                   3.1s
#9 [5/5] RUN go build ...                          41.8s
```

The last two lines rebuilt because the source tree changed; the first three came free from cache.
This is why the project's one-time build takes 20-40 minutes but routine re-runs are seconds, and
why dependency files are `COPY`ed before the source tree. Two practical rules: keep frequently
edited files nearest the *end* of a Dockerfile, and rerun untouched builds only to fetch new cache.

### Cross-architecture builds with buildx

The hard constraint of this course: the upstream Google project publishes images compiled for
`linux/amd64`, but the k3s node (and your Apple Silicon Mac) is `aarch64`/`arm64`. An amd64 binary
simply cannot execute on an arm64 kernel (attempts are caught by the kernel's *binfmt* handler and
forwarded to an emulator — QEMU or Docker Desktop's Rosetta 2). So images must be *built* for
arm64. Buildx can do this, but only when you tell it which architecture(s) the final image must
target: `docker buildx build --platform linux/arm64 ...`.

Buildx exposes four **automatic args** to every Dockerfile. You saw defaults for three of them
above:

| Auto arg | Meaning | Value with `--platform linux/arm64` |
|---|---|---|
| `TARGETPLATFORM` | the full target platform string | `linux/arm64` |
| `TARGETOS` | just the OS part | `linux` |
| `TARGETARCH` | just the CPU part | `arm64` |
| `BUILDPLATFORM` | the platform on which the *build tools* themselves run | `linux/amd64` (Rosetta/QEMU emulation on Apple Silicon) |

`BUILDPLATFORM` is the subtle one. It answers "what machine will run the compiler?" — with
`--platform linux/arm64`, the compiler itself is amd64 and must execute under emulation, which is
slow. The project sidesteps this by *also* setting `BUILDPLATFORM=linux/arm64` at the CLI, so the
builder stage itself is arm64 and runs natively; only the toolchain-bootstrap demo, were it x86,
would need emulation.

**The real bug this project fixed.** The `cartservice` Dockerfile pinned `ARG TARGETARCH=amd64` as
a default. With only `--platform linux/arm64`, the automatic `TARGETARCH=arm64` did **not** win
that explicit-arg race; `dotnet publish -a $TARGETARCH ...` produced an amd64 binary and stamped it
inside an image labeled arm64. At runtime the node's binfmt handler handed the foreign ELF to
Rosetta, which failed with:

```
rosetta error: failed to open elf at /lib64/ld-linux-x86-64.so.2
```

The architecture mismatch surfaced only at runtime as a confusing loader error, not at build time.
The fix, baked into `onlineBoutique/scripts/03-build-push-images.sh`, forces every
build-relevant arg explicitly:

```bash
docker buildx build \
  --platform linux/arm64 \
  --build-arg BUILDPLATFORM=linux/arm64 \
  --build-arg TARGETARCH=arm64 \
  --build-arg TARGETOS=linux \
  -f "$(ctx "$svc")/Dockerfile" \
  -t "$ECR_REGISTRY/$ECR_REPO_PREFIX/$svc:$IMAGE_TAG" \
  "$(ctx "$svc")"
```

The lesson generalizes: **never trust automatic args when a Dockerfile gives the arg a default**;
always pass the value explicitly, and always verify the artifact afterward (the lab below does just
that with `docker image inspect`).

### Docker networking primer (a preview for later modules)

Because each container has its own *net namespace*, containers need a network to talk to each
other. Docker's default is a `bridge` network: containers get private IPs (typically `172.17.x.x`)
but there is **no DNS** — you cannot connect from one container to another by name. *User-defined
networks* (created with `docker network create floci-net` and joined with `docker network connect`)
start an embedded DNS server, so containers on `floci-net` can resolve each other's names.

That single fact is responsible for one of the course's real bugs, which you'll meet again in
Module 08 -> ECR & Container Registries: Floci's ECR proxy resolves its registry sidecar *by
container name* (`http://floci-ecr-registry:5000`). On the default bridge, that name does not
resolve, so every data-plane push returned `503 Service Unavailable`. Attaching the involved
containers to `floci-net` (done idempotently by `onlineBoutique/scripts/01-fix-floci-network.sh`)
restored name-based resolution and unblocked pushes. The Kubernetes analogue — in-cluster DNS for
service discovery — is Module 05 -> Kubernetes Services & Networking.

## Hands-On Lab

Goal: build `frontend` for `linux/arm64`, then prove — with `docker image inspect` and a layer
listing — that the resulting image really is arm64, and understand the role of the explicit
`--build-arg`s. The identical commands are what `03-build-push-images.sh` runs for all eleven
services.

### Step 1 — Make sure the upstream sources exist

From the monorepo root:

```bash
cd onlineBoutique
source scripts/00-env.sh
scripts/02-clone-upstream.sh
```

`02-clone-upstream.sh` pins `https://github.com/GoogleCloudPlatform/microservices-demo.git` at
tag `v0.10.7`. `00-env.sh` exports the values reused below — `AWS_PROFILE=floci-eks`, the ECR
registry `000000000000.dkr.ecr.us-east-1.localhost:4566`, `IMAGE_TAG=v0.10.7`, and the service
list. Check your own copies: both files are in your repo and are the reference source for this
module (`onlineBoutique/scripts/00-env.sh`, `onlineBoutique/scripts/03-build-push-images.sh`).

### Step 2 — Build frontend for arm64

From inside the upstream clone (the `src/frontend` paths below are relative to it):

```bash
cd microservices-demo

docker buildx build \
  --platform linux/arm64 \
  --build-arg BUILDPLATFORM=linux/arm64 \
  --build-arg TARGETARCH=arm64 \
  --build-arg TARGETOS=linux \
  -f src/frontend/Dockerfile \
  -t 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7 \
  src/frontend
```

Observe the output: buildx prints a numbered step list (`#N [M/Q] ...`). Map each step back to the
Dockerfile you read above — you should see the golang builder stage pulled, `COPY go.mod go.sum ./`
followed by `RUN go mod download`, then the source `COPY` and the `go build`, and finally the
distroless final stage. Because this is the *first* build nothing is cached, so the compile step
takes the longest; re-running the same command later should show `CACHED` steps instead.

### Step 3 — Verify the architecture

The build says "arm64", but verify the artifact rather than trusting the label:

```bash
{% raw %}
docker image inspect \
  --format '{{.Architecture}}' \
  000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7
{% endraw %}
```

Expect `arm64`. This single command is the entire reason the `cartservice` race (amd64 binary in an
arm64-labeled image) gets caught: image label and actual payload must agree. If they disagree, you
have rebuilt the bug — the runtime error it produces is the `rosetta error: failed to open elf ...`
line from the concepts section.

### Step 4 — List the image's layers

To see the layer stack your build produced:

```bash
docker history 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7 --no-trunc | head
```

(`docker history` is a community plugin for the Docker CLI; if it is not installed, the same layer
breakdown appears in the build output's `#N [M/Q]` lines and in most Docker Desktop image
inspectors.) Observe that the layer count is small and that distroless and the Go compiler never
landed in the final image — only the static binary and the `templates/` + `static/` payloads did.

### Step 5 — What `--build-arg TARGETARCH=arm64` actually does

Compare the two ways to reach "arm64":

- `--platform linux/arm64` alone asks buildx to *target* arm64 and sets the automatic args
  (`TARGETPLATFORM=linux/arm64`, `TARGETARCH=arm64`, `TARGETOS=linux`). This works *only if* the
  Dockerfile uses plain `ARG TARGETARCH` with no default. If a Dockerfile hard-codes
  `ARG TARGETARCH=amd64` (as `cartservice` does), the auto arg is shadowed.
- `--build-arg TARGETARCH=arm64` (and friends) *force the value at the CLI*, overriding any
  Dockerfile default. This is what makes the build deterministic across all eleven services and is
  why every service's build in this project passes the three `--build-arg`s explicitly.

The rule: use `--platform` once at the top so layering/pull behavior matches the target, and always
repeat `TARGETARCH`/`TARGETOS`/`BUILDPLATFORM` as explicit `--build-arg`s so a Dockerfile default
can never silently win.

### Step 6 — See it automated for all services

The command you just ran by hand is exactly one iteration of the loop in
`onlineBoutique/scripts/03-build-push-images.sh`. That script,

```bash
for svc in $SERVICES; do
  aws --profile "$AWS_PROFILE" ecr create-repository \
    --repository-name "$ECR_REPO_PREFIX/$svc" > /dev/null 2>&1 || true

  docker buildx build \
    --platform linux/arm64 \
    --build-arg BUILDPLATFORM=linux/arm64 \
    --build-arg TARGETARCH=arm64 \
    --build-arg TARGETOS=linux \
    -f "$(ctx "$svc")/Dockerfile" \
    -t "$ECR_REGISTRY/$ECR_REPO_PREFIX/$svc:$IMAGE_TAG" \
    "$(ctx "$svc")"

  docker push "$ECR_REGISTRY/$ECR_REPO_PREFIX/$svc:$IMAGE_TAG"

  docker exec floci-eks-dev-cluster \
    crictl rmi "$ECR_REGISTRY/$ECR_REPO_PREFIX/$svc:$IMAGE_TAG" > /dev/null 2>&1 || true
done
```

walks eleven services from `00-env.sh`, creating each ECR repository up-front, building arm64,
pushing, and then evicting the local k3s image cache so the cluster is forced to re-pull a
re-pushed tag (`imagePullPolicy: IfNotPresent` in the manifest would otherwise keep the old digest).
Note the cartservice special case: its Dockerfile is nested a level deeper (`src/cartservice/src`),
which the script's `ctx()` helper resolves. You now understand — and can explain — every line of
the course's most important build script.

## Common Pitfalls

- **Legacy `docker build` instead of `docker buildx`.** Plain `docker build` predates
  `--platform`/auto args and cannot produce a cross-arch image. Use `docker buildx build` (default
  on modern Docker Desktop).
- **Forgetting the explicit `--build-arg`s.** Relying on `--platform` alone is exactly how the
  `cartservice` bug bit: a Dockerfile default (`ARG TARGETARCH=amd64`) shadowed the auto arg and
  shipped an amd64 binary in an arm64 image. Always pass `TARGETARCH`, `TARGETOS`, and
  `BUILDPLATFORM` explicitly.
- **Trusting the image label**. Verify with
  `docker image inspect --format '{% raw %}{{.Architecture}}{% endraw %}' <image>` before pushing. A confused
  `rosetta error: failed to open elf at /lib64/ld-linux-x86-64.so.2` at runtime is the tell-tale
  that an x86 ELF landed in an arm64 image.
- **Copying sources before dependency files.** `COPY . .` before `COPY go.mod go.sum` (or
  `COPY requirements.txt`) forces every code edit to rebuild all dependency layers. Put rarely
  changing files first, constantly changing files last.
- **Not pinning base images.** Unpinned `FROM golang:latest` breaks reproducibility. The project
  pins builder bases by digest (`@sha256:...`), so a build is byte-identical weeks later.
- **Expecting a shell in the final image.** Distroless/chiseled final stages have no shell and no
  package manager — `docker exec` will have nothing to exec into. Debug through logs
  (`docker logs`) instead.

## Key Takeaways

- A container is not a small VM: it is namespaces (pid, net, mnt) plus cgroups, i.e. ordinary
  processes given isolated views of the host kernel. Images are read-only layer stacks on a union
  filesystem with a writable copy-on-write top layer.
- The Dockerfile is a recipe: `FROM` seeds, `COPY` imports, `RUN` builds files, `ENTRYPOINT` and
  `CMD` define start behavior, `ARG` feeds the build and `ENV` feeds the process.
- Multi-stage builds keep compilers out of production: the Go services build in
  `golang:1.27.0-alpine` and ship only a static binary on `gcr.io/distroless/static`;
  `cartservice` cross-compiles with `dotnet publish -a $TARGETARCH --self-contained` onto a
  chiseled base; Python services copy `site-packages` from a builder onto a clean copy of the same
  Alpine base.
- Layers make Docker incremental: unchanged layers are served from cache on rebuild, which is why
  dependency metadata is `COPY`ed before the source tree and why re-running the build is seconds.
- Buildx auto args (`TARGETPLATFORM`/`TARGETARCH`/`TARGETOS`/`BUILDPLATFORM`) drive cross-arch
  builds, but a Dockerfile default can shadow them — the `cartservice` amd64-in-arm64 bug and its
  runtime `rosetta error` are the proof. Force the args and verify with `docker image inspect`.
- Docker's default bridge network resolves no container names; user-defined networks such as
  `floci-net` do. That difference is the root cause of the ECR `/v2/` 503 bug covered in Module 08.

## Review Questions

1. In one sentence each, what is the difference between a process, a VM, and a container, and which
   two Linux mechanisms implement containers?
2. Why is the project's build cache-friendly even though each Dockerfile step creates a layer —
   and what ordering rule in the Go Dockerfiles keeps rebuilds cheap?
3. The Go services' final stage is `gcr.io/distroless/static`. What is missing from that image, and
   what debugging consequence does that have?
4. Name the four buildx auto args and say what `BUILDPLATFORM` controls that the other three do
   not.
5. Describe the `cartservice` architecture bug end to end: what the Dockerfile did, what the image
   contained, what error users saw, and how the project's script fixes it.
6. Why does the default Docker bridge stop Floci's ECR push from working, and how does the fix —
   used by this project — relate to container-name DNS?

### Answers

1. A process is one address space run by the host kernel; a VM is a full guest OS on emulated
   hardware under a hypervisor; a container is a group of processes isolated by Linux namespaces
   (pid, net, mnt) and so unhidden from the host kernel, with resource use bundled in cgroups.
   Containers are therefore seconds-to-start and MB-sized, while VMs cost a kernel.
2. Every filesystem-touching instruction becomes a layer, and buildx caches completed layers, so an
   unchanged layer is reused (`CACHED`) on the next build. The Go Dockerfiles `COPY go.mod go.sum`
   before `COPY . .`, keeping the expensive `RUN go mod download` layer cached across code edits;
   the rule is "rarely-changing files first, frequently-changing files last".
3. It has no shell, no package manager, no compiler — nothing beyond the statically linked binary
   and its files. The consequence: you cannot `docker exec` into the container for interactive
   debugging; all diagnosis happens through container logs.
4. `TARGETPLATFORM` (full `os/arch` string), `TARGETOS` (the OS part), `TARGETARCH` (the CPU part),
   and `BUILDPLATFORM` (the platform the build *tools* run on). `BUILDPLATFORM` is the one that
   controls emulation of the toolchain: forcing it to `linux/arm64` lets the compiler run natively
   instead of under Rosetta/QEMU.
5. The Dockerfile declared `ARG TARGETARCH=amd64` with a default; `--platform linux/arm64` alone
   did not override it, so `dotnet publish -a $TARGETARCH` produced an amd64 self-contained binary
   inside an image labeled arm64. At runtime Rosetta could not load the ELF
   (`failed to open elf at /lib64/ld-linux-x86-64.so.2`). The script fixes it by always passing
   `--build-arg BUILDPLATFORM=linux/arm64 --build-arg TARGETARCH=arm64 --build-arg TARGETOS=linux`
   and the lab confirms it with `docker image inspect --format '{% raw %}{{.Architecture}}{% endraw %}'`.
6. On the default bridge, containers are reachable only by IP — the name `floci-ecr-registry`
   never resolves, so Floci's ECR proxy (which resolves the registry sidecar by container name)
   returned `503 Service Unavailable` on `/v2/` requests. Attaching the involved containers to a
   user-defined network (`docker network create floci-net`) starts embedded DNS, making
   container-name resolution work; `01-fix-floci-network.sh` re-applies this wiring.