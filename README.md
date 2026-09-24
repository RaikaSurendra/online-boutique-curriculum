# Online Boutique on Kubernetes — A Hands-On Tutorial

A structured, project-based tutorial built around a **real, working system**: Google's
[Online Boutique](https://github.com/GoogleCloudPlatform/microservices-demo) (11 microservices)
deployed to a locally-emulated EKS cluster (Floci + k3s) on an Apple Silicon Mac.

Every concept is taught bottom-up and immediately exercised with the actual commands and
manifests from this repository. By the end you will have deployed the shop yourself, understood
how every piece works, and be able to troubleshoot and extend it.

## Repository map

```
online-boutique-curriculum/
├── README.md              # this syllabus
├── STYLE.md               # formatting rules for the modules
├── 00-getting-started.md
├── 01-docker-containers.md
├── 02-kubernetes-core.md
├── 03-microservices-architecture.md
├── 04-online-boutique-deep-dive.md
├── 05-kubernetes-services-networking.md
├── 06-aws-eks-floci.md
├── 07-iam-eks-authentication.md
├── 08-ecr-registries.md
├── 09-observability-load-testing.md
├── 10-tooling-cicd.md
├── 11-troubleshooting.md
└── 12-capstone-final-exam.md
```

Sibling repositories used as the tutorial's lab environment:

- `floci-microservices-online-boutique/eksSetup/` — the Floci EKS cluster bootstrap
- `floci-microservices-online-boutique/onlineBoutique/` — image build + deployment scripts
  and manifests for the shop

## Syllabus

### Part I — Foundations (Modules 00–03)

| Module | Title | Core topics |
|---|---|---|
| 00 | Getting Started | Environment, tools (Docker, aws CLI, kubectl), repo layout, course mechanics |
| 01 | Docker & Containers | Images vs containers, Dockerfile, multi-stage builds, layers, buildx, arm64 vs amd64 |
| 02 | Kubernetes Core | Cluster architecture, Pod/Deployment/ReplicaSet, Namespaces, ServiceAccounts, probes, init containers, resources, rollouts |
| 03 | Microservices Architecture | Monolith vs microservices, bounded contexts, service-to-service calls, the Online Boutique topology |

### Part II — The Application (Modules 04–05)

| Module | Title | Core topics |
|---|---|---|
| 04 | Online Boutique Deep Dive | All 11 services, their languages (Go/.NET/Java/Node/Python), ports, protocols, the 980-line manifest |
| 05 | Kubernetes Services & Networking | ClusterIP/LoadBalancer/NodePort, DNS (CoreDNS), service discovery, gRPC, k3s ServiceLB |

### Part III — AWS EKS (Modules 06–08)

| Module | Title | Core topics |
|---|---|---|
| 06 | AWS EKS & the Floci Emulator | EKS architecture, VPC/IGW/subnets/SG/route tables, Floci, k3s real-mode, why "dev-cluster" is a k3s |
| 07 | IAM & EKS Authentication | IAM users/roles/policies, access keys, `aws eks get-token`, exec credential plugin, token webhook, the `floci-eks` profile fix |
| 08 | ECR & Container Registries | Registry control plane vs data plane, docker login/push, registry mirrors, the `/v2/` 503 DNS bug |

### Part IV — Operations (Modules 09–12)

| Module | Title | Core topics |
|---|---|---|
| 09 | Observability & Load Testing | Logs, metrics-server, `kubectl top`, readiness/liveness, Locust load generator |
| 10 | Tooling & CI/CD | kubectl, helm, skaffold, kustomize, port-forward, shell-automating the build/deploy |
| 11 | Troubleshooting | ImagePullBackOff, CrashLoopBackOff, ErrImagePull, events, the three real bugs this project fixed |
| 12 | Capstone & Final Exam | Deploy/scale/recover on your own; comprehensive review and exam with answers |

## How to use

- Follow the modules in order; labs assume the cluster from Module 00/06 is running.
- Each module lists the earlier modules you need as prerequisites.
- Quizzes throughout build toward the final capstone (Module 12).

## Course outcomes

By the end of this tutorial you will be able to:

1. Explain and create Docker images (multi-stage, cross-arch) and run containers.
2. Describe the full Kubernetes object model and deploy workloads with Deployments/Services.
3. Explain microservice architecture using a real 11-service system.
4. Authenticate to an EKS-style cluster via IAM and understand the token flow.
5. Push/pull from a container registry and understand registry internals.
6. Observe, load-test, troubleshoot, and clean up a real deployment.

## Getting the lab environment

```bash
# Clone the project monorepo
git clone https://github.com/RaikaSurendra/floci-microservices-online-boutique.git
cd floci-microservices-online-boutique

# Bootstrap the cluster (Part I prerequisite)
cd eksSetup && ./scripts/setup-eks.sh

# Deploy the shop (used from Module 03 onward)
cd ../onlineBoutique
source scripts/00-env.sh
scripts/01-fix-eks-auth.sh
scripts/01-fix-floci-network.sh
scripts/02-clone-upstream.sh
scripts/03-build-push-images.sh
scripts/04-deploy.sh
```