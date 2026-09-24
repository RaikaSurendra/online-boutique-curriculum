---
layout: module
title: "Module 08: ECR & Container Registries"
slug: 08-ecr-registries
meta:
  part: Part III — AWS EKS
  subtitle: Control plane vs data plane, docker login/push, registry mirrors
---

# Module 08: ECR & Container Registries

## Learning Objectives

By the end of this module you will be able to:

- Explain what a container registry is, and split it into a *control plane* (account-level
  repository management) and a *data plane* (the `/v2/` push/pull HTTP API).
- Distinguish a repository, a tag, a digest, and a manifest, and read a `describe-images`
  response.
- Explain how AWS ECR authenticates a Docker client (`GetAuthorizationToken` -> `docker login`)
  and how the Floci emulator reproduces the same flow on your laptop.
- Describe the `*.localhost` trick that makes the emulated registry a loopback "insecure"
  registry with no TLS configuration.
- Explain the real `503 Service Unavailable` bug caused by container-name DNS on the default
  Docker `bridge` network, and how a user-defined network (`floci-net`) fixes it.
- Trace the in-cluster pull path through the k3s registries mirror and work around the
  `IfNotPresent` tag-caching trap.

## Prerequisites

- Module 01 (Docker images, tags, buildx, arm64 vs amd64).
- Module 06 (Floci emulating AWS services, including ECR).
- Module 07 (the `floci-eks` profile and named AWS credentials).

## Time estimate

Reading: 60 min · Hands-on: 45 min

## Concepts

### What a container registry actually is

A container registry is a server that stores images and hands them out over HTTP. Teams never
share images by hand-copying tarballs; they push to a registry that any machine can pull from.
The wire protocol is standardized by the *OCI distribution specification* (often written
"OCI Distribution Spec"), so any well-behaved client (Docker, containerd, Podman) can talk to
any well-behaved registry (Docker Hub, ECR, GCR, or the tiny `registry:2` container used here).

Four terms appear constantly; the difference between them is the difference between a label,
an address, and the thing itself. On first use, define them:

- A *repository* is a named collection of images for one piece of software, for example
  `microservices-demo/frontend`. It is a path, not an image.
- A *tag* is a human-friendly, mutable label attached to one image in a repository, for
  example `v0.10.7`. Tags move: the same tag can point at a different image tomorrow.
- A *digest* is the immutable content address of an image, a SHA-256 over its manifest, for
  example `sha256:dcb22a0cafd6939244175b06b6f91eaef983cd2b8c66655ff28aeee7d4e3954e`.
  Change one byte anywhere in the image and the digest changes. References look like
  `repo@sha256:...` (immutable) versus `repo:tag` (mutable).
- A *manifest* is a JSON document that lists the image's layers and configuration. It is itself
  a blob addressed by digest. A *manifest list* (also called *image index*) is a manifest that
  points at platform-specific child manifests, one per architecture, so a single tag can serve
  `linux/arm64` and `linux/amd64`; the client picks the child that matches its CPU.

The actual bytes of image layers are called *blobs* (opaque byte streams). A push sends the
layers as blobs first, then a manifest that names them; a pull fetches the manifest, reads the
blob list, and downloads only the missing layers.

### Control plane vs data plane

Every registry has two independent halves. The **control plane** manages account-level
metadata: authentication tokens, creating and deleting repositories, listing images. In AWS
this is the ECR API (`aws ecr ...`). The **data plane** moves bytes: the `/v2/` HTTP endpoints
that Docker's push/pull invoke. It is a dumb, fast file server with a manifest index.

```
        aws CLI                          docker / containerd
          |                                    |
          v                                    v
 +--------+-----------------------------------------+------------+
 | CONTROL PLANE (ECR API)                           | DOCKER    |
 |  GetAuthorizationToken  create-repository        | LOGIN     |
 |  describe-repositories  describe-images          +------------+
 |  repo metadata, auth                              | DATA PLANE|
 |                                                   | /v2/ ...  |
 |                                                   |   blobs/  |
 |                                                   | manifests/|
 +--------------+------------------------------------+-----------+
                |
      one registry service, two surfaces
```

This split explains the asymmetry you will feel in the labs: the control plane can be working
perfectly while the data plane is completely broken, because they are different code paths.
That is exactly what happened in this project.

### AWS ECR on real AWS

On real AWS, ECR provides a *private registry per account and region*. If your account number
were `123456789012` and you were in `us-east-1`, the registry host would be

```
123456789012.dkr.ecr.us-east-1.amazonaws.com
```

Docker pushes are anonymous over HTTP unless authed first, so `docker push` to ECR requires
credentials. AWS deliberately does not let you log in with your IAM access key directly.
Instead you call the control plane to mint a short-lived token:

```
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com
```

`GetAuthorizationToken` returns a base64 string of the form `AWS:<bytes>`; that whole blob is
the password. `docker login` stores it (in `~/.docker/config.json` on your host, keyed by the
registry hostname) so later pushes can reuse it. The token expires after about 12 hours, which
is why login is a step in every build script.

ECR also has a repository-level setting called *tag mutability*. With `MUTABLE` (the default),
repushing a tag overwrites which image it points to; with `IMMUTABLE`, the registry rejects the
push if the tag already exists. The emulated registries in this class report
`"imageTagMutability": "MUTABLE"`, which is exactly what the build loop relies on when it
repushes the same `v0.10.7` tag after fixing an image.

### This project's registry: Floci emulates ECR

Floci impersonates the AWS control plane: `aws ecr create-repository`, `describe-images`,
`get-login-password`, and friends all answer over `http://localhost:4566`. Under the hood the
data plane is a real *OCI registry*, the `registry:2` Docker image, running as a sidecar
container named `floci-ecr-registry`. Floci proxies every `/v2/...` request to it.

The registry URI used everywhere in this course is

```
000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/<svc>:v0.10.7
```

Read it field by field: account `000000000000`, region `us-east-1`, host `.dkr.ecr.....`,
port `4566`, repository path `microservices-demo/<svc>`, tag `v0.10.7`. Only two things differ
from the real AWS form: the terminal `.amazonaws.com` is replaced by `.localhost`, and `:4566`
is appended. Everything else (control plane, login flow, push flow, the digit tag) is identical
to production, so everything you learn here transfers.

### The `*.localhost` trick

`.localhost` is a special-use domain (RFC 6761). Any hostname ending in `.localhost` resolves to
the loopback interface on your machine. That means

```
000000000000.dkr.ecr.us-east-1.localhost:4566  ->  127.0.0.1:4566
```

and `localhost:4566` is the Floci endpoint. Two consequences make the whole emulation
"just work" with zero TLS pain:

1. The name resolves to your own machine, where Floci listens, no DNS or `/etc/hosts` edits
   needed, on any computer.
2. Docker treats loopback registries (`localhost` and `127.0.0.0/8`) as *insecure registries*
   automatically: no TLS, no self-signed-cert warnings, no `insecure-registries` daemon config.
   The registry sidecar is only ever reached on that loopback-facing host.

### The real bug: `/v2/` returns 503 (container-name DNS)

Here is the failure documented in `eksSetup/Error_Documentation.md` as
`ECR_DATA_PLANE_503_CONTAINER_DNS`. `docker push` worked far enough to upload layers, then died:

```
unknown: unexpected status from HEAD request to
  http://000000000000.dkr.ecr.us-east-1.localhost:4566/v2/microservices-demo/frontend/blobs/sha256:...: 503 Service Unavailable
```

Note the control plane was fine: `aws ecr create-repository` and `describe-repositories`
worked. Only the data plane failed. The root cause is a Docker networking subtlety. Floci
reaches its registry sidecar by **container name**:

```
http://floci-ecr-registry:5000
```

That works only if the two containers share a Docker network that can resolve container names.
The default Docker `bridge` network has **no container-name DNS**; it is a plain L2/L3 bridge.
When Floci ran on that default bridge, the name lookup failed and every proxied `/v2/` call
returned `503 Service Unavailable` with an empty body.

User-defined networks are different. When you run `docker network create floci-net`, Docker
provisions an *embedded DNS server* for that network, reachable by containers at
`127.0.0.11`, and registers every attached container's name. That is the whole fix.

```
 BEFORE (default bridge)           AFTER (floci-net, user-defined)
 +-----------------------+         +-------------------------------+
 | floci  --name lookup--> X       | floci ---> floci-ecr-registry  | embedded
 |    http://floci-ecr-registry     |    container-name resolves     | DNS
 |    no DNS  => 503                |    /v2/ => 200                 | 127.0.0.11
 +-----------------------+         | floci-eks-dev-cluster (k3s) ... +----+
                                   +-------------------------------+
```

The heal script `onlineBoutique/scripts/01-fix-floci-network.sh` re-applies the wiring any
time it is needed (it is idempotent, meaning running it twice is harmless). Its real logic is
a small pattern worth memorizing:

```bash
{% raw %}
NET="floci-net"

# create the network if it does not exist
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create "$NET"
fi

# find a container by name filter, then attach it if it is not already on $NET
floci_cid=$(docker ps -aq --filter "name=^/floci$")
if ! docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$floci_cid" \
   | tr ' ' '\n' | grep -qx "$NET"; then
  docker network connect "$NET" "$floci_cid"
fi
{% endraw %}
```

`docker network connect floci-net <container>` cannot corrupt anything, and a duplicate attach
is reported as an error (`endpoint with name ... already exists in network floci-net`) that
changes no state. The script dodges that noise by pre-checking membership with
`docker network inspect`, so re-running the whole script is a guaranteed no-op:
`docker network connect` is effectively idempotent for the purpose of a health-check script.
Three containers get attached: `floci`, `floci-ecr-registry`, and `floci-eks-dev-cluster` (the
k3s cluster, so its in-network pods can reach the registry too).

This is a generic Docker lesson, not a Floci quirk: any container that talks to another by name
must share a user-defined network. The default `bridge` gets you outbound internet and port
mapping but not name-based service discovery. `--link` on the bridge provides one-way aliases as
a legacy escape hatch; user-defined networks provide full DNS for everyone attached.

### The login and push flow

The two commands that move images are exactly what a real EKS pipeline would run, with the
Floci hostname and profile swapped in:

```bash
aws ecr get-login-password --profile floci-eks | \
  docker login --username AWS --password-stdin 000000000000.dkr.ecr.us-east-1.localhost:4566
# -> Login Succeeded

docker push 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7
```

`03-build-push-images.sh` wraps the push in a loop over every service and adds two bookkeeping
steps: an idempotent `aws ecr create-repository` (the `|| true` swallows "already exists") and a
cache eviction described below.

### The in-cluster pull path: the k3s registries mirror

Inside the cluster the images are pulled by `containerd`, k3s's container runtime. The runtime
does not speak the AWS control plane, so how do pods pull without credentials or secret?
Because the node never touches the AWS control plane at all. k3s reads
`/etc/rancher/k3s/registries.yaml`, which Floci snapshot at cluster creation time. You can see
the real file right now:

```bash
docker exec floci-eks-dev-cluster cat /etc/rancher/k3s/registries.yaml
```

It maps the `*.localhost:4566` repo hosts onto Floci's in-network address. The real, observed
entry for our region reads:

```yaml
mirrors:
  "000000000000.dkr.ecr.us-east-1.localhost:4566":
    endpoint:
      - "http://172.17.0.2:4566"
```

(Floci also registers the other regions' `...localhost:4566` hosts for good measure.) So when
containerd asks for `000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/frontend:v0.10.7`,
it transparently rewrites the endpoint to `http://172.17.0.2:4566` (the floci container's IP on
the Docker bridge) and pulls over plain HTTP on the private emulation network. This is why no
imagePullSecrets, no login, and no TLS appear anywhere in the manifests: the mirror does all the
work before the runtime sees a URL.

### The tag-caching trap

Kubernetes default `imagePullPolicy` for a pod whose image reference has a tag (not a digest) is
`IfNotPresent`; once the node has an image with that tag, k3s refuses to re-download it. That is
fast and correct for immutable tags but silently wrong when you repush a corrected image under
the same tag. This bites in exactly the situation Module 01 created: the upstream
`.NET` cartservice image did not run on the arm64 node, you rebuild it for arm64, and
`docker push` wins, then deploy... and the pod still uses the stale cached image.

The fix is to evict the node's cache entry so the next pod start re-pulls from the mirror:

```bash
docker exec floci-eks-dev-cluster \
  crictl rmi 000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/cartservice:v0.10.7

kubectl delete pods -n online-boutique -l app=cartservice   # recreate from fresh image
```

`03-build-push-images.sh` bakes this eviction into its loop ("[cache] evicted
cartservice:v0.10.7 from k3s containerd"), so you rarely need to do it by hand mid-course,
but you must know why the step exists. A tag is a lie until you look at the digest; `IfNotPresent`
believes the tag.

## Hands-On Lab

All commands below are the real ones used in this project. The profile is `floci-eks`, the
endpoint is `http://localhost:4566`, and the registry host is
`000000000000.dkr.ecr.us-east-1.localhost:4566`.

```bash
# 1. Control plane: list every repository (expect the 11 microservices-demo/* repos)
aws ecr describe-repositories --profile floci-eks
```

Observe the output: one `repositoryArn` per repo (namespace `microservices-demo/`), `registryId`
`000000000000`, an account-local `repositoryUri`, `"imageTagMutability": "MUTABLE"`, and
`"encryptionType": "AES256"`. Count the repos:

```bash
aws ecr describe-repositories --profile floci-eks | grep -c repositoryName    # -> 11
```

```bash
# 2. Data plane inventory: what does one repository hold?
aws ecr describe-images --repository-name microservices-demo/frontend --profile floci-eks
```

Study this response. There is one `imageDetail` with `"imageTags": ["v0.10.7"]`, an immutable
`imageDigest` (`sha256:...`), and crucially `"imageManifestMediaType":
"application/vnd.oci.image.index.v1+json"` -- the manifest-list type described in the Concepts
section, waiting for a platform-specific child to be selected by the pulling client. (In the
emulator `imageSizeInBytes` is 0; real ECR reports the byte-size of the pushed payload.)

```bash
# 3. Mint a token and log Docker in (password flows over stdin, never a file)
aws ecr get-login-password --profile floci-eks | \
  docker login --username AWS --password-stdin 000000000000.dkr.ecr.us-east-1.localhost:4566
# -> Login Succeeded
```

`Login Succeeded` means the daemon accepted `AWS:<base64>` as the password for that hostname and
persisted it. Re-run the same command and notice it is cheap and idempotent.

```bash
# 4. Probe the data plane directly (no auth; /v2/ is the registry's discovery endpoint)
curl -s -o /dev/null -w '%{http_code}\n' http://000000000000.dkr.ecr.us-east-1.localhost:4566/v2/
# -> 200
```

A `200` says the whole proxy chain is alive: `localhost:4566` -> floci -> `floci-ecr-registry`.
This is the exact check `01-fix-floci-network.sh` runs. Before the bug fix this returned `503`.

```bash
# 5. See the in-cluster mirror that lets pods pull without credentials
docker exec floci-eks-dev-cluster cat /etc/rancher/k3s/registries.yaml | head -20
```

You should see the `mirrors:` block with the `...localhost:4566` host mapped to an
`http://172.17.0.2:4566` endpoint, as in the Concepts section.

```bash
# 6. Confirm the networking layout the fix depends on
docker network ls
```

Find `floci-net` (bridge driver, local scope). It is the user-defined network whose embedded DNS
lets floci resolve `floci-ecr-registry`. Without it, every push would die with a 503.

Optional drill (do not leave changes behind): re-run the heal script and watch it no-op.

```bash
onlineBoutique/scripts/01-fix-floci-network.sh
```

You should see `[ok]` lines for `floci`, `floci-ecr-registry`, and `floci-eks-dev-cluster`
("already on floci-net"), a `docker login` line, and `OK: .../v2/ -> 200` -- a smoke test of the
whole control-plane/data-plane story.

## Common Pitfalls

- **Docker Desktop restart drops nothing that hurts you, but re-running the heal script may
  be needed anyway.** Docker persists attached networks across daemon restarts, but if any of
  the three containers is recreated (or you compose the environment fresh), re-run
  `01-fix-floci-network.sh` before pushing. It is designed to be safe to run at any time.
- **Interpreting a 503 as a bad push.** A `503 Service Unavailable` with an empty body on a
  `/v2/...` call while `aws ecr ...` works is a data-plane-only symptom. Diagnose with the
  `curl /v2/` check, not by rebuilding the image.
- **Repushing a corrected image and wondering why pods still misbehave.** `IfNotPresent`
  caches by tag. Evict with `crictl rmi` plus a pod delete, or simply re-run
  `03-build-push-images.sh`, which evicts automatically.
- **Pushing amd64 under an arm64 tag.** The arm64 node cannot run an amd64 child manifest, yet
  the push succeeds and the cache keeps it. Fix the platform in the build (`--platform
  linux/arm64`, `TARGETARCH=arm64`), repush, then evict the cache.
- **Treating the tag as the identity.** Never debug images by tag alone; compare digests
  (`aws ecr describe-images`) between registry and node (`crictl images`).
- **Logging in "once, later".** ECR tokens expire; if a push is suddenly rejected with
  `unauthorized`, rerun the `get-login-password | docker login` pipe rather than hunting a
  credential file.

## Key Takeaways

- A registry is two services in one: an account-level control plane (repo metadata, auth) and
  a stateless `/v2/` data plane (blobs and manifests). Broken data plane with healthy control
  plane is a real, observed failure mode.
- Tags are mutable labels; digests are immutable content addresses; the manifest/index is the
  architecture-aware index that lets one tag serve arm64 and amd64.
- The Floci ECR emulator keeps every AWS ceremony (`get-login-password`, `docker login`,
  push, describe) while swapping `amazonaws.com` for `.localhost:4566`, and `.localhost`
  plus loopback-insecure handling remove TLS from the problem entirely.
- Container-name service discovery only works on user-defined Docker networks; the default
  `bridge` has no DNS, which produced this course's real 503 bug. The fix is `floci-net`
  and an idempotent, rerun-safe heal script.
- k3s pulls through a `registries.yaml` mirror because of in-cluster images; the node never
  needs registry credentials because the mirror rewrites the endpoint first.
- `imagePullPolicy: IfNotPresent` plus mutable tags is a stale-artifact machine; evict the
  node's cache (`crictl rmi`) after any repush.

## Review Questions

1. You run `aws ecr describe-repositories` successfully, but `docker push` dies with
   `503 Service Unavailable` on a `/v2/...` call. Which half of the registry is broken, and
   what is the one curl command that confirms it?
2. Why does a single tag like `:v0.10.7` describe both an arm64 and an amd64 image, and which
   field in `describe-images` proves it?
3. Explain in two or three sentences why `000000000000.dkr.ecr.us-east-1.localhost:4566`
   needs no TLS configuration at all when talking to Docker.
4. The Floci proxy addresses its registry as `http://floci-ecr-registry:5000`. Why does that
   fail on the default `bridge` network and work on `floci-net`?
5. A pod still runs the old, broken cartservice after you repush `v0.10.7`. What two commands
   force the node to forget the stale image, and why is `kubectl delete pods` needed in
   addition to the cache eviction?
6. Where does k3s learn how to reach the registry, and why does the pull succeed with no
   imagePullSecret in any manifest?

### Answers

1. The **data plane** is broken. The control plane (ECR API) answers fine; only `/v2/` fails.
   `curl -s -o /dev/null -w '%{http_code}' http://000000000000.dkr.ecr.us-east-1.localhost:4566/v2/`
   returns `503` (it returns `200` when healthy).
2. The tag points at an image index (manifest list). Its
   `imageManifestMediaType` is `application/vnd.oci.image.index.v1+json`, an index of
   platform-specific child manifests; the client selects the one matching its architecture.
3. `.localhost` is defined by RFC 6761 to resolve to the loopback, so the hostname reaches
   `127.0.0.1`, and Docker automatically treats loopback registries as insecure, requiring no
   TLS or `insecure-registries` config.
4. The default `bridge` network runs no embedded DNS, so the name `floci-ecr-registry` cannot
   be resolved (proxy returns 503). User-defined networks such as `floci-net` include Docker's
   embedded DNS (127.0.0.11), which resolves attached container names.
5. `docker exec floci-eks-dev-cluster crictl rmi <registry>/microservices-demo/cartservice:v0.10.7`
   removes the cached image, then `kubectl delete pods ...` (or restart) forces the ReplicaSet
   to create a new pod that must re-pull. The cache eviction alone does not replace a running pod.
6. Through `/etc/rancher/k3s/registries.yaml`, snapshotted at cluster creation. Its `mirrors:`
   block rewrites the `*.localhost:4566` hosts to `http://172.17.0.2:4566` (floci's in-network
   address), so containerd talks straight to the registry data plane over the private network
   without any credentials.