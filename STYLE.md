# Style Guide — Online Boutique on Kubernetes Tutorial

All modules in this tutorial MUST follow this format and tone.

## Global rules

- Markdown (.md), GitHub-flavored, US English.
- **No emojis.** No AI/AI-tool mentions. Author is neutral instructor.
- Audience: developers with basic programming skills (know what a
  terminal, a package manager, and HTTP are). Assume little to no prior Docker/k8s/AWS knowledge.
- Tone: tutorial + textbook. Explain **why**, not just **how**. Prefer building intuition from
  first principles, then anchor with the real, working example in this repo.
- Always reference the real project artifacts when possible:
  - `eksSetup/scripts/setup-eks.sh`, `eksSetup/Error_Documentation.md`
  - `onlineBoutique/scripts/*.sh` (00-env, 01-fix-eks-auth, 01-fix-floci-network,
    02-clone-upstream, 03-build-push-images, 04-deploy, 05-verify, 99-cleanup)
  - `onlineBoutique/manifests/kubernetes-manifests.yaml`
  - The cluster: Floci EKS `dev-cluster` (k3s v1.34, arm64 node), namespace `online-boutique`.
- Only use shell commands that are real and were used in this project (verify against the
  scripts listed above). Do NOT invent endpoints/commands that were never used.

## File naming

`NN-topic-slug.md`, zero-padded two-digit numbers. `README.md` is the syllabus.

## Per-module structure (MUST contain these sections, in this order)

1. **Module `<N>: <Title>`** (H1)
2. **Learning Objectives** — 4-6 bullet points starting with "By the end..."
3. **Prerequisites** — which earlier modules are required (e.g., "Module 01, 02")
4. **Time estimate** — e.g., "Lecture: 60 min, Lab: 90 min"
5. **Concepts** — the theory, broken into H2 sections. Include ascii diagrams in fenced
   code blocks where helpful.
6. **Hands-On Lab** — H2 "Hands-On Lab". Give real, copy-pasteable commands with expected
   output where known. Tie to the actual project scripts/manifest. Include "observe the
   output" guidance.
7. **Common Pitfalls** — H3 list of frequent mistakes and their fixes.
8. **Key Takeaways** — 4-6 summary bullets.
9. **Review Questions** — 5-8 questions, followed by an H3 "Answers" block with short
   answers (hidden via `<details>` is NOT required; put them right below).

## Style notes

- Use fenced code blocks with language tags: `bash`, `yaml`, `dockerfile`, `go`, `text`.
- Keep code snippets short and purposeful. Full-file references point at the repo path.
- Diagrams: plain ASCII inside triple backticks, keep under 20 lines.
- For each k8s/AWS/Docker concept, define jargon in one sentence before using it (glossary
  inline, italicized on first use).
- Length guidance: each module ~350-600 lines of markdown. Dense but scannable.

## Consistency tokens

Use these names/values everywhere (do not invent):
- Cluster: `dev-cluster`
- Namespace: `online-boutique`
- ECR registry: `000000000000.dkr.ecr.us-east-1.localhost:4566/microservices-demo/<svc>:v0.10.7`
- AWS profile: `floci-eks`, IAM user `eks-admin`, admin IAM key subject to policy
- Docker network: `floci-net`
- Floci endpoint: `http://localhost:4566`
- Upstream: GoogleCloudPlatform/microservices-demo, tag `v0.10.7`
- The 12 deployments: frontend, adservice, cartservice, checkoutservice, currencyservice,
  emailservice, loadgenerator, paymentservice, productcatalogservice, recommendationservice,
  shippingservice, redis-cart
- k3s node: arm64 (`aarch64`), upstream images are `linux/amd64`; we build arm64 from source.

## Cross-referencing

Reference other modules as `Module 04 -> Kubernetes Services` or `../02-kubernetes-core.md`.
Keep cross refs short.