---
layout: module
title: "Module 07: IAM & EKS Authentication"
slug: 07-iam-eks-authentication
meta:
  part: Part III — AWS EKS
  subtitle: Users, roles, access keys, aws eks get-token, the token webhook
---

# Module 07: IAM & EKS Authentication

## Learning Objectives

By the end of this module you will be able to:

- Explain what IAM is and how its four core ideas — users, roles, policies, and access keys — relate,
  and read the contents of `~/.aws/credentials` and `~/.aws/config` confidently.
- Describe why kubectl cannot use a password against EKS and why authentication is delegated to `aws
  eks get-token` as an *exec credential plugin*.
- Trace the full authentication flow from a `kubectl` command through a SigV4-signed STS request to
  the token webhook that grants Kubernetes identity.
- Read a kubeconfig "users" block and explain what each `exec` argument does.
- Reproduce the exact fix `onlineBoutique/scripts/01-fix-eks-auth.sh` applies: create the `eks-admin`
  user, attach `AdministratorAccess`, store its key in the `floci-eks` profile, and regenerate the
  kubeconfig.
- Diagnose the boundary between authentication ("who are you?", handled by IAM + token) and
  authorization ("what may you do?", handled by RBAC group membership).

## Prerequisites

Modules 02 and 06 (Kubernetes core, and AWS EKS & the Floci emulator). You should understand the EKS
object model, know that `dev-cluster` runs as a k3s container reachable at `https://localhost:6500`,
and be comfortable that every AWS call is pointed at `http://localhost:4566`.

## Time Estimate

Lecture: 90 min, Lab: 60 min

## Concepts

### IAM: Identity and Access Management Primer

*Identity and Access Management (IAM)* is AWS's system of "who may do what". It has four recurring
concepts, and almost every AWS security conversation is a sentence combining them:

- *User*: an identity for a person or application that needs its own credentials. A user can hold
  credentials (a password for the web console, an access key for the CLI) and be granted permissions.
  In this project the user is `eks-admin`.
- *Role*: an identity without long-lived credentials, meant to be *assumed* — either by AWS services
  (`eks.amazonaws.com` assuming `eks-role` in Module 06) or by other principals. Roles are how
  machines get temporary permissions without exposing a secret.
- *Policy*: a JSON document that states whether given *actions* are allowed or denied on given
  *resources*. There are two placements. An *identity-based policy* is attached to a user/role and
  says what that identity may do; a *resource-based policy* is attached to the resource and says who
  may do things to it. The pattern to remember: identity-based policies are "who -> what", resource
  policies are "what -> who".
- *Access key*: a pair of long-lived credentials — `AccessKeyId` and `SecretAccessKey` — that lets a
  program sign API requests. The CLI reads them from files (below); the AWS SDK signs every call with
  them. Anyone holding a valid pair acts as that identity.
- *Managed policy*: a ready-made policy AWS publishes and can attach by ARN. This project uses two:
  `arn:aws:iam::aws:policy/AmazonEKSClusterPolicy` (given to the `eks-role` in Module 06) and
  `arn:aws:iam::aws:policy/AdministratorAccess` (given to the `eks-admin` user here).

When you see `AdministratorAccess` you should read "full, unfiltered permissions over everything in
the account." It is the IAM equivalent of `sudo` with no prompts.

**Credential files.** The AWS CLI stores your identity in two plain-text files. `~/.aws/credentials`
holds secret material only:

```text
[floci-eks]
aws_access_key_id = <AccessKeyId of eks-admin>
aws_secret_access_key = <SecretAccessKey of eks-admin>
```

`~/.aws/config` holds addresses and preferences for the same profiles. Note the required
`[profile ...]` header — this asymmetry (no `profile` keyword in credentials, `profile` required in
config) is a classic trap:

```text
[profile floci-eks]
region = us-east-1
endpoint_url = http://localhost:4566
output = json
```

Three fields matter for this course. `region` pins all calls to `us-east-1`, matching the cluster.
`endpoint_url = http://localhost:4566` is the whole reason everything stays local (Module 06). And
the CLI flag `--profile floci-eks` (or the equivalent `AWS_PROFILE=floci-eks` in the shell) selects a
stored profile over the unnamed `[default]`. Profiles are how you keep the emulator's fake account
separate from any real AWS account that might otherwise be sitting in `[default]`.

### Why kubectl Needs Authentication at All on EKS

On a hand-built cluster (Module 02), `kubectl` authenticates with a client certificate or a static
token stored in a file. EKS has no such user: **there is no "password" for an EKS API server, and
client certificates are not issued to humans.** Real EKS answers one question user with IAM. The API
server does not know what IAM is, so AWS bridges the two: you authenticate to IAM first, and IAM's
verdict is converted into a Kubernetes identity.

Historically this bridge was the *aws-iam-authenticator*: a binary you installed, listed in the
kubeconfig, that fetched short-lived credentials from IAM and talked to the API server out of band.
Modern EKS replaces that binary entirely with the AWS CLI itself, via `aws eks get-token`. The CLI
package is already on your machine, one fewer installation to get right, and the flow is fully
described by *exec credential plugin* — kubeconfig's standard escape hatch for "ask an external
program to produce my token."

### The Token Flow (The Whole Story)

This is the heart of the module. Trace each step against the diagram, then again against the real
commands, until it is boring.

```text
kubectl --kubeconfig -> exec: aws eks get-token -> token (k8s-aws-v1.<b64 presigned GetCallerIdentity URL>)
  -> kube-apiserver -> token-webhook (Floci /_floci/eks/clusters/dev-cluster/token-webhook)
  -> TokenReview -> username floci:aws-iam, groups [system:masters]
```

1. **kubectl decides it needs a credential.** Every kubectl call reads its kubeconfig, finds the
   `exec` block under the current user, and invokes the program and arguments listed there — `aws
   eks get-token --cluster-name dev-cluster --profile floci-eks`.
2. **The AWS CLI authenticates to IAM.** Using the keys in the `floci-eks` profile (reading
   endpoint, region, and endpoint_url from the profile), the CLI builds one special API request:
   `sts:GetCallerIdentity`, the "who am I?" call of AWS. Nothing is sent yet; the request is
   *pre-signed* — signed with your `SecretAccessKey` using SigV4, AWS's canonical request-signing
   algorithm — so that whoever receives it can verify it came from `eks-admin` without needing the
   key.
3. **The token is a signed URL, not a magic string.** The CLI base64-encodes that presigned
   GetCallerIdentity URL and prefixes it with the marker `k8s-aws-v1.`. That whole string is the
   bearer token returned to kubectl. Nothing secret lives in it — the secret is the *signature* baked
   in by `eks-admin`'s key.
4. **kubectl presents the token.** kubectl attaches it as an `Authorization: Bearer k8s-aws-v1....`
   header to the HTTPS request against the api-server at `https://localhost:6500`.
5. **The api-server asks for a second opinion.** Kubernetes cannot verify an AWS signature itself. Its
   *token review* mechanism forwards an `authentication.k8s.io/v1` TokenReview containing the token
   to the configured *webhook* — for EKS that is AWS itself; for Floci it is
   `/_floci/eks/clusters/dev-cluster/token-webhook` on the emulator (a probe of this endpoint is
   documented in `eksSetup/Error_Documentation.md: EKS_TOKEN_WEBHOOK_REJECTS_TEST_CREDS`).
6. **The webhook validates and maps.** Floci verifies the SigV4 signature by replaying the presigned
   request (now against its own STS at `localhost:4566`), learns the caller is IAM user `eks-admin`
   in account `000000000000`, and replies with a TokenReview: `authenticated: true`, username
   `floci:aws-iam`, groups `[system:masters]`.
7. **RBAC takes over.** The api-server records that identity and from here on answers authorization
   questions purely from Kubernetes RBAC: is the (fake) user `floci:aws-iam` or one of its groups
   `system:masters` allowed to `list nodes`? Because `system:masters` is the built-in cluster-admin
   group, the answer is yes — which is exactly why the token webhook is so protective in step 6.

Three-step summary to memorize: **IAM proves who you are -> the token carries that proof -> RBAC says
what that identity may do.** Authentication (steps 1-6) and authorization (step 7) are separate:
getting a valid token gets you in the door, but only your groups decide which doors.

### The Kubeconfig That the Plugin Writes

`aws eks update-kubeconfig --name dev-cluster --profile floci-eks` generates a `kind: Config` that
points at the emulated endpoint and installs the exec plugin. The certificate data is redacted here,
but the *shape* is the part that matters:

```yaml
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: <redacted>
    server: https://localhost:6500
  name: arn:aws:eks:us-east-1:000000000000:cluster/dev-cluster
contexts:
- context:
    cluster: arn:aws:eks:us-east-1:000000000000:cluster/dev-cluster
    user: arn:aws:eks:us-east-1:000000000000:cluster/dev-cluster
  name: arn:aws:eks:us-east-1:000000000000:cluster/dev-cluster
current-context: arn:aws:eks:us-east-1:000000000000:cluster/dev-cluster
users:
- name: arn:aws:eks:us-east-1:000000000000:cluster/dev-cluster
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args:
      - --region
      - us-east-1
      - eks
      - get-token
      - --cluster-name
      - dev-cluster
      - --profile
      - floci-eks
      interactiveMode: IfAvailable
```

Keys to read off this document (your exact argument order may vary slightly by aws CLI version):

- `clusters[].cluster.server` is `https://localhost:6500` — the k3s API publisher, not a real AWS
  host, because this is the emulator.
- `users[].user.exec.command` is `aws`, the same CLI you curl with, reused as an identity provider.
- The `exec.args` are the arguments kubectl will invoke: `--region us-east-1`,
  `--cluster-name dev-cluster`, and **`--profile floci-eks`**. That last one is load-bearing: it is
  what makes the plugin read the profile's `endpoint_url`, so the token gets signed against the
  emulator rather than real AWS.
- There are no `client-certificate` or `client-key` fields. EKS deliberately has no static
  credentials; tokens are generated fresh on every request.

### The Real Bug This Project Fixed

Before the fix, `kubectl get nodes` produced the classic rejection:

```text
error: You must be logged in to the server (the server has asked for the client to provide credentials)
```

Meanwhile `aws eks describe-cluster` reported `ACTIVE`, the k3s container was healthy, and k3s logs
showed `invalid bearer token`. How can the cluster be up but refuse everyone? The answer, documented
in `eksSetup/Error_Documentation.md` under `EKS_TOKEN_WEBHOOK_REJECTS_TEST_CREDS`, is a deliberate
safety feature:

> Floci's k3s token webhook **deliberately rejects** the public local-development key pairs
> `test`/`test` and `floci`/`floci`. A successful TokenReview grants `system:masters` (cluster-admin)
> — so an emulator that accepted any well-known public key would hand out full cluster-admin to
> anyone who knew the public secret. The original setup used `test`/`test`, so every token the
> webhook examined came back `authenticated: false`, and every kubectl call was rejected.

The fix, applied by `onlineBoutique/scripts/01-fix-eks-auth.sh`, is to stop using a well-known key
and create a dedicated real one inside the emulator's IAM:

1. Create the IAM user and attach full admin permissions:
   ```bash
   aws iam create-user --user-name eks-admin
   aws iam attach-user-policy --user-name eks-admin \
     --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
   ```
2. Issue a genuine access key for it and store the pair in the `floci-eks` profile with
   `aws configure set`, including `region us-east-1`, `endpoint_url http://localhost:4566`, and
   `output json`:
   ```bash
   aws configure set aws_access_key_id     <AccessKeyId>     --profile floci-eks
   aws configure set aws_secret_access_key <SecretAccessKey> --profile floci-eks
   aws configure set region                us-east-1         --profile floci-eks
   aws configure set endpoint_url          http://localhost:4566 --profile floci-eks
   ```
3. Regenerate the kubeconfig so the exec plugin signs with that profile instead of the rejected key:
   ```bash
   aws eks update-kubeconfig --name dev-cluster --profile floci-eks
   ```
4. Prove it:
   ```bash
   kubectl get nodes
   kubectl auth whoami
   ```

The script is *idempotent*: it first checks whether `kubectl get nodes` already works; if it does, it
prints the nodes and exits without touching anything. Only when authentication is broken does it do
the work above. That makes it safe to run at the start of every lab, and it is exactly the script the
course's README calls before the deploy scripts.

The subtlety that makes this a genuine puzzle rather than a configuration typo: **IAM calls
(`iam create-user`, `iam create-access-key`) all succeed with `test`/`test` — authorization only
fails at the Kubernetes door.** So the surface symptom (kubectl rejects you) pointed nowhere near the
real cause (kubectl was signing with the wrong, public key). Diagnosis required looking at the token,
not the cluster.

### Identity Mapping Outcome

Once the real profile is in place, `kubectl auth whoami` — the Kubernetes answer to "who does the
API think I am?" — reports:

```text
ATTRIBUTE   VALUE
Username    floci:aws-iam
Groups      [system:masters system:authenticated]
```

Read the columns deliberately. The *username* `floci:aws-iam` is not your IAM user — it is the label
the webhook chose for "some authenticated IAM principal". Kubernetes saw a valid IAM identity but not
your name, so it reports the category. The *groups* are the entire answer to "what may I do?":
`system:masters` is the hard-coded cluster-admin group, and `system:authenticated` is applied
automatically to any successfully authenticated request. IAM got you in the door; the group `masters`
is why every door in the building is open.

### The Design Lesson: Low-Privilege Defaults vs This Emulator

AWS's own guidance is that developers should run with the least privilege that makes their work
possible: create a scoped user, grant only the actions that user needs. The `eks-admin` +
`AdministratorAccess` combination here is deliberately, dramatically the opposite — full powers. So
why?

Because the emulator flips the normal threat model. In the real cloud, `test`/`test` credentials
touch nothing (they are not valid keys in any account), so they are harmless to leave around. Here,
the emulator *treats* those public keys as valid, and worse, every valid-looking identity gets a
cluster-admin token. The failure mode is not "someone abuses your fake keys" but "everyone's fake key
admits everyone into the cluster." In this flipped world, creating a dedicated, non-public key pair is
the way to reclaim the normal property that membership is controlled: only the holder of the `eks-admin`
secret can obtain a `system:masters` token.

The transferable lesson, worth more than the cluster itself: **defaults are not "safe" or "unsafe" in
the abstract; they are safe relative to the threat model they were designed for.** Test the defaults
against your actual environment (this course's error documentation is a good example of doing exactly
that), and when the environment inverts the model, create dedicated credentials instead of reusing
well-known ones.

## Hands-On Lab

Source the environment and confirm your identity is the dedicated user:

```bash
source onlineBoutique/scripts/00-env.sh
aws --profile floci-eks sts get-caller-identity
```

Expected output (the `UserId` value is an opaque Floci-generated ID; the `Arn` is exact):

```text
{
    "UserId": "AIDA...<opaque>",
    "Account": "000000000000",
    "Arn": "arn:aws:iam::000000000000:user/eks-admin"
}
```

`Account: 000000000000` and the `eks-admin` user confirm you are speaking to the emulator's single
fake account, using the dedicated key, not `test`/`test`.

**Inspect the token (without leaking it).** The next command produces exactly the bearer token
described in the flow. You only need its head to verify the prefix:

```bash
aws eks get-token --cluster-name dev-cluster --profile floci-eks | head -c 200
echo
```

Expected shape (truncated at 200 characters):

```text
k8s-aws-v1.aHR0cHM6Ly9sb2NhbGhvc3Q6NDU2Ni8_QWN0aW9uPUdldENhbGxlcklkZW50aXR5JlZlcnNpb249MjAxMS0wNi0xNSZYL...
```

Notice the `k8s-aws-v1.` marker. The base64 payload after the prefix decodes to the presigned
GetCallerIdentity URL — you can confirm this yourself by piping just the payload to
`base64 -d`; it reveals an HTTPS URL with `Action=GetCallerIdentity`. **Do not print the full token**
in any shell you care about: it is a bearer credential, valid for the cluster, and anyone who reads
it can impersonate you until it expires.

**Confirm who the API server thinks you are:**

```bash
kubectl auth whoami
```

Expected output:

```text
ATTRIBUTE   VALUE
Username    floci:aws-iam
Groups      [system:masters system:authenticated]
```

**And that the cluster is reachable under that identity:**

```bash
kubectl get nodes
```

Expected output mirrors Module 06:

```text
NAME                     STATUS   ROLES                  AGE   VERSION
floci-eks-dev-cluster    Ready    control-plane,master   2d    v1.34.1
```

**Run the fixer (even though it is already fixed).** The whole point of idempotency:

```bash
onlineBoutique/scripts/01-fix-eks-auth.sh
```

Expected output, since everything already works:

```text
kubectl already authenticates to dev-cluster via profile floci-eks.
...
kubectl get nodes  -> (the node list again)
```

If authentication were broken, this script would silently create `eks-admin`, attach
`AdministratorAccess`, write the profile, regenerate the kubeconfig, and print the verified node and
whoami output — that is the exact repair sequence from the Concepts section.

**Optional: watch RBAC gate a sensitive object.** With cluster-admin, this succeeds and prints the
secrets list — but try it mentally as a scoped user (any identity outside `system:masters`) and it
returns `Forbidden`. This is authorization in action, separate from the IAM authentication you just
exercised:

```bash
kubectl -n kube-system get secret
```

If you want to *feel* the difference later, temporarily remove the profile's admin policy and watch
`kubectl get nodes` continue to succeed (auth still passes) while `kubectl auth whoami --as=...` and
privilege checks change — but restore it promptly afterwards, because the build scripts expect admin.

## Common Pitfalls

- **Exec plugin timing out / rejecting without `--profile`.** The kubeconfig must contain
  `--profile floci-eks` in `exec.args` (or the shell must export `AWS_PROFILE=floci-eks`). Without a
  profile, the plugin falls back to `[default]`, usually `test`/`test`, and the webhook returns
  `authenticated: false`. k3s waits a few seconds for the token and then the request dies with a
  timeout or credential error. Verify with `kubectl config view --minify` that `--profile floci-eks`
  is present.
- **`AWS_PROFILE` and `--profile` divergence.** kubectl never reads your shell's `AWS_PROFILE`; it
  only obeys the kubeconfig exec args. Meanwhile bare `aws` commands use `AWS_PROFILE`. If the two
  disagree, `aws sts get-caller-identity` can report `eks-admin` while `kubectl get nodes` still
  fails under a stale kubeconfig. Fix by regenerating the kubeconfig with
  `aws eks update-kubeconfig --name dev-cluster --profile floci-eks`.
- **`endpoint_url` missing from the profile.** The exec plugin runs inside kubectl's environment,
  which does not necessarily have `AWS_ENDPOINT_URL` exported. The token signs against the STS URL it
  can reach, which is whatever `endpoint_url` the profile names. If `endpoint_url` is missing, the
  plugin tries real `sts.amazonaws.com`, the fake `eks-admin` key is rejected, and every kubectl
  call fails. `endpoint_url` must live in the `floci-eks` profile — this is why the fix script
  explicitly writes it with `aws configure set`.
- **Forgetting that auth and authorization are different.** A cluster that is `ACTIVE` may still
  refuse you (the bug above: cluster fine, identity rejected). And a validated identity can still get
  `Forbidden` on objects outside its RBAC groups. Diagnose the two separately: `aws eks
  describe-cluster` proves the plane is up; `kubectl auth whoami` proves authentication; RBAC errors
  start with a `Forbidden` you cannot fix with credentials.

## Key Takeaways

- IAM is users, roles, and policies expressed as JSON; access keys (`AccessKeyId`/
  `SecretAccessKey`) are how the CLI and SDK prove identity, stored in `~/.aws/credentials` and
  `~/.aws/config`.
- EKS has no password users; kubectl authenticates through `aws eks get-token`, an exec credential
  plugin that signs an STS `GetCallerIdentity` request and returns a bearer token prefixed
  `k8s-aws-v1.`.
- The token is a SigV4-presigned URL, base64-encoded: proof of IAM identity, not a shared secret.
  The api-server verifies it via a token webhook, which maps the caller to Kubernetes identity and
  groups.
- Floci's webhook deliberately rejects `test`/`test` and `floci`/`floci` because a positive TokenReview
  grants `system:masters`; the fix is a dedicated `eks-admin` user with `AdministratorAccess` stored
  in the `floci-eks` profile.
- `kubectl auth whoami` shows Username `floci:aws-iam` and Groups `[system:masters
  system:authenticated]` — IAM proved identity, the group grants cluster-admin, and RBAC makes the
  final call on every request.
- Defaults are only safe relative to their threat model; when an environment inverts that model,
  create dedicated, non-public credentials instead of relying on well-known ones.

## Review Questions

1. What is the difference between a user and a role in IAM, and which does `eks-admin` fall into?
2. Why does kubectl have no static credentials (password or client certificate) in EKS?
3. What exactly is stored inside a `k8s-aws-v1.` token, and what proves the signature is valid?
4. Walk through what happens at the Floci token webhook when it receives a token signed with the
   `test`/`test` key pair.
5. If `kubectl auth whoami` reports Username `floci:aws-iam`, why is it not your IAM username, and
   where does authorization actually come from?
6. Two machines both signed tokens as `eks-admin`. One succeeds against the cluster; the other gets
   rejected. Which single value in the profile is most likely different, and what did we learn in
   pitfall three about it?

### Answers

1. A user is a long-lived identity with its own credentials that stays in the account; a role is a
   temporary identity assumed by someone or something (like EKS assuming `eks-role`).
   `eks-admin` is a user — it holds the access keys the exec plugin signs with.
2. EKS authenticates through IAM as its single source of identity; there are no console-created
   passwords or per-user certificates. The exec credential plugin (`aws eks get-token`) fetches a
   short-lived, IAM-proven token on every request instead.
3. The base64 payload of a `k8s-aws-v1.` token decodes to a presigned AWS STS `GetCallerIdentity`
   URL. Nothing secret is in the token itself; the SigV4 signature generated with the caller's
   `SecretAccessKey` is what the webhook verifies when it replays the request against STS.
4. The webhook recognizes the `test`/`test` pair as public well-known development credentials and
   deliberately answers `authenticated: false` (shown in
   `Error_Documentation.md: EKS_TOKEN_WEBHOOK_REJECTS_TEST_CREDS`). The api-server then refuses the
   request, producing the "You must be logged in" / "invalid bearer token" symptom.
5. `floci:aws-iam` is the label the webhook chose for "a successfully authenticated IAM principal" —
   Kubernetes does not see your IAM user name. All authorization flows from the RBAC groups returned
   in the TokenReview: `system:masters` (cluster-admin) and `system:authenticated` (present on every
   valid request).
6. Almost certainly `endpoint_url`. If it is missing from the `floci-eks` profile, the exec plugin
   signs against real `sts.amazonaws.com` (because kubectl's environment does not export
   `AWS_ENDPOINT_URL`), and the emulator cannot verify a signature it never issued. The fix writes
   `endpoint_url = http://localhost:4566` into the profile and regenerates the kubeconfig.