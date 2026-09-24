---
layout: module
title: "Module 06: AWS EKS & the Floci Emulator"
slug: 06-aws-eks-floci
meta:
  part: Part III — AWS EKS
  subtitle: EKS architecture, VPC/subnets/SG, Floci, k3s real mode
---

# Module 06: AWS EKS & the Floci Emulator

## Learning Objectives

By the end of this module you will be able to:

- Explain why Amazon Elastic Kubernetes Service (EKS) exists and what AWS manages on your behalf: a
  managed control plane, managed worker nodes, and deep integration with IAM, VPC, ECR, and CloudWatch.
- Name and describe the key EKS objects: `cluster`, `nodegroup`, Fargate profile, `addon`, and access
  entry, and say which ones this lab's setup actually uses versus which are AWS console concepts.
- Describe the EKS control-plane model: AWS runs the api-server and etcd for you; you provide the VPC,
  the node IAM role, and the subnets.
- Explain what Floci is and why `dev-cluster` on this machine is a real Kubernetes cluster
  (rancher/k3s) running inside a Docker container rather than a simulation.
- Enumerate the AWS networking primitives an EKS cluster requires (VPC, Internet Gateway, subnets,
  security group, route table) and reproduce the exact `aws` CLI calls the setup script uses.
- Point every AWS call at `http://localhost:4566` instead of the real cloud, and recognize that the
  same CLI commands transfer directly to real AWS.

## Prerequisites

Modules 01, 02, and 05 (Docker & containers, Kubernetes core, and Kubernetes services & networking).
You should already know what a Pod, a Deployment, a Namespace, and a Service are before studying how
EKS hosts them.

## Time Estimate

Lecture: 75 min, Lab: 60 min

## Concepts

### Why Amazon EKS Exists

Running Kubernetes yourself means operating the *control plane*: the API server (the front door for
everything), `etcd` (the key-value store that is the source of truth for every object), the scheduler,
and the controllers that reconcile the world toward your desired state. You also have to secure and
upgrade all of it, in high availability, across three or more availability zones. In Module 02 you
touched this machinery only through `kubectl`; in production someone must keep those components alive
24x7.

Amazon Elastic Kubernetes Service (EKS) removes that burden. It is a *managed Kubernetes service*:
AWS runs the control plane for you, applies security patches, performs version upgrades, and handles
failure recovery. Your account still pays for the worker nodes (the machines that actually run your
Pods), but the plane that administers them is AWS's problem, not yours.

Beyond "we run the control plane", EKS exists because no AWS service succeeds in isolation. AWS makes
Kubernetes useful on their platform by wiring the control plane into everything a real application
needs:

- *IAM*: the same identities that authorize `aws` CLI calls can authenticate to the Kubernetes API — a
  subject Module 07 covers in depth.
- *VPC*: the control plane and its nodes run inside your Virtual Private Cloud, so Kubernetes uses
  your subnets, route tables, and security groups.
- *ECR*: Pods pull container images from Amazon's Elastic Container Registry, the subject of Module 08.
- *CloudWatch*: API server audit and control-plane logs are shipped to the observability service
  automatically.

The pitch is short: "give us the network and the IAM role, and you get a certified, upgraded, always-up
API server." That is why `kubectl` against an EKS cluster feels identical to `kubectl` against a
hand-built cluster — underneath it is still Kubernetes, just one somebody else babysits.

### Key EKS Objects

An EKS account has several object types. Know them by name even though this lab only creates a sparse
subset, because job interviews and Day-2 operations ask about them:

- *Cluster*: the top-level object that represents one Kubernetes control plane. It has a name, a
  Kubernetes version, an endpoint URL, a role ARN, and a VPC configuration. `aws eks create-cluster`
  creates one; everything else attaches to it.
- *NodeGroup*: a managed group of EC2 worker nodes. AWS builds them with the Amazon EKS optimized AMI,
  registers them with the cluster, and can autoscale them. This lab has no managed node group; the
  k3s node *is* the control plane container.
- *Fargate Profile*: a way to run Pods **without** any EC2 nodes at all. AWS Fargate provisions the
  underlying compute on demand to run each Pod in its own sandbox. A profile is a selector that says
  "Pods in these namespaces/labels run on Fargate."
- *Addon*: a supported, versioned extension that AWS installs and upgrades for you — for example
  `vpc-cni`, `coredns`, `kube-proxy`, and `aws-ebs-csi-driver`. Addons are the managed way to install
  cluster-level software.
- *Access Entry*: a modern IAM-to-Kubernetes mapping that says "this IAM principal may connect to the
  cluster with these RBAC groups." Access entries are the current successor to the older
  `aws-auth` ConfigMap mechanism and are conceptually what Module 07 demonstrates end to end.

A real cluster typically has all five. Ours has exactly one: a `cluster` object whose worker plane is
a k3s container, with no Fargate profiles, no managed node group, and no AWS addons — because Floci
emulates only what a local developer actually needs.

### The EKS Control-Plane Model

Conceptually EKS splits the cluster into two ownership domains:

- *AWS owns the control plane.* The api-server, `etcd`, controller-manager, and scheduler run in an
  AWS-managed VPC across three availability zones. AWS exposes the API server at an HTTPS endpoint and
  guarantees its availability. You never see the box, never `ssh` in, and never patch it.
- *You own the data plane.* You choose the subnets where worker nodes run, the instance sizes, the
  IAM role those nodes assume, and the security group rules that let the control plane reach them.
  Your nodes join the cluster over a private VPC connection.

So the *minimal contract* you must satisfy to create a cluster is: a VPC, at least two subnets in
different availability zones, and an IAM role that EKS is allowed to assume. In AWS terms:

```text
you provide                     AWS provides (managed)
-------------                   ----------------------
VPC + subnets                   api-server (HA)
node IAM role                   etcd (HA, encrypted)
security groups                 scheduler
                               controller-manager
                               automatic upgrades & patching
```

Everything the turquoise-and-dark cluster in the AWS console does is layered on top of these three
inputs. This is the mental model to keep while the emulator runs: the "cluster object" is thin
metadata; the real machinery is the VPC-plus-IAM you built around it.

### Floci: AWS for Your Laptop

*Floci* is an open-source AWS emulator, similar in spirit to LocalStack but designed to run *real
services* in Docker on your machine rather than mocking their APIs. When you call
`aws eks create-cluster`, Floci does not return a JSON shell that pretends a control plane exists —
in its EKS *real mode* it actually launches a container running **rancher/k3s** and hands you a real
`ACTIVE` cluster you can drive with `kubectl`.

That is why `dev-cluster` is genuinely a Kubernetes cluster. `kubectl get nodes` returns one
`Ready` arm64 node, `kube-system` runs real `coredns`, `metrics-server`, and
`local-path-provisioner` Pods, and a real Deployments/Services control loop runs underneath. The
k3s version in this environment is **v1.34.1**, recent enough to behave like the Kubernetes you
studied in Module 02.

Why bother? Development feedback. On a laptop, `kubectl apply -f` should produce real Pods you can
curl in seconds, not a mock queue. Floci gives you that fidelity while keeping everything local and
zero-cost — and because the AWS API surface is the real one, the commands you learn here are the
commands you will type against real EKS later (Module 07 makes this point concretely).

### The Floci Runtime Topology on This Machine

Your Docker Desktop host currently runs three related containers plus a user-defined network:

```text
Docker Desktop (arm64 host)
  floci container            (AWS API emulator on http://localhost:4566)
    ├── floci-eks-dev-cluster (k3s, API published on host 6500 -> 6443)
    └── floci-ecr-registry    (registry:2 sidecar for ECR data plane)
  floci-net                  (user-defined Docker network, shared by the above)
```

Read it from the top down:

- **Docker Desktop** is the whole universe. Everything is a container on this machine.
- **`floci`** is the emulator itself. It publishes an AWS-compatible REST API on
  `http://localhost:4566` — the same port LocalStack uses, by design, so wall-clock muscle memory from
  other AWS-local tools still applies.
- **`floci-eks-dev-cluster`** is the k3s container Floci launched to back `dev-cluster`. It binds
  its Kubernetes API server to host port **6500**, which maps to the container's native **6443** (the
  standard kube-apiserver port). The kubeconfig you write in the lab points at
  `https://localhost:6500`.
- **`floci-ecr-registry`** is a `registry:2` sidecar that serves the ECR *data plane* (the `/v2/...`
  push/pull endpoints). Module 08 returns here.
- **`floci-net`** is a *user-defined Docker network*. Unlike the default `bridge`, it provides
  container-name DNS, so `floci` can reach its children as `floci-eks-dev-cluster` and
  `floci-ecr-registry` by hostname. Without it, the ECR push proxy fails with `503` — a real bug
  recorded in `eksSetup/Error_Documentation.md` under `ECR_DATA_PLANE_503_CONTAINER_DNS`, and the
  reason `onlineBoutique/scripts/01-fix-floci-network.sh` exists.

### AWS Networking Primitives the Setup Creates

Before EKS touches anything, the setup script builds a miniature AWS network with the public CLI.
Each object exists in real EKS for a specific reason; learn the reason, then the IAM role, then the
cluster.

The setup script in `eksSetup/scripts/setup-eks.sh` generates timestamped resource names
(`eks-vpc-$TIMESTAMP` and friends). The tags matter: they are what let later scripts find the
resources — `aws ec2 describe-vpcs --filters Name=tag:Name,Values=eks-vpc*` is a real command you run
in the lab.

**VPC.** A *Virtual Private Cloud* is your own logically isolated section of AWS's network, a single
CIDR range with no neighbors. Everything else in this list lives inside it. EKS needs one because the
control plane and nodes must share an address space.

```bash
VPC_ID=$(aws ec2 create-vpc \
    --cidr-block 10.0.0.0/16 \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=$VPC_NAME}]" \
    --query 'Vpc.VpcId' --output text)
```

The supernet `10.0.0.0/16` leaves 65,536 addresses for the subnets below.

**Internet Gateway.** An *Internet Gateway (IGW)* is the hook that connects your private VPC to the
public internet. It is useless until a route sends traffic through it, but it is the required middle
man: EKS nodes pull images, reach ECR, and let `kubectl` talk to the API server over paths that
ultimately cross the IGW.

```bash
IGW_ID=$(aws ec2 create-internet-gateway \
    --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=$VPC_NAME-igw}]" \
    --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID
```

**Subnets.** A *subnet* is a /24 slice of the VPC pinned to one *availability zone* (AZ) — a
physically separate data center region inside the region. Three subnets, one per AZ, give EKS's
high-availability control plane somewhere to spread its replicas and give your future nodes
redundant homes:

```bash
SUBNET1_ID=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 \
    --availability-zone us-east-1a --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$SUBNET1_NAME}]" \
    --query 'Subnet.SubnetId' --output text)
SUBNET2_ID=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 \
    --availability-zone us-east-1b --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$SUBNET2_NAME}]" \
    --query 'Subnet.SubnetId' --output text)
SUBNET3_ID=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.3.0/24 \
    --availability-zone us-east-1c --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$SUBNET3_NAME}]" \
    --query 'Subnet.SubnetId' --output text)
```

Notice the pattern: `10.0.1.0/24` in `us-east-1a`, `10.0.2.0/24` in `us-east-1b`,
`10.0.3.0/24` in `us-east-1c`. The subnet IDs are stored for the cluster creation call.

**Security Group.** A *security group* is a stateful firewall attached to resources, with inbound
rules keyed on protocol, port, and CIDR. For cluster management traffic the script opens the four
ports a cluster operator touches: **22** (SSH for debugging), **80** and **443** (HTTP/HTTPS), and
**6443** (the Kubernetes API server port):

```bash
SG_ID=$(aws ec2 create-security-group --group-name $SECURITY_GROUP_NAME \
    --description "Security group for EKS cluster" --vpc-id $VPC_ID \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$SECURITY_GROUP_NAME}]" \
    --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 22  --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 80  --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 6443 --cidr 0.0.0.0/0
```

**Route Table + Default Route.** A *route table* is the VPC's forwarding table. Every subnet that
needs internet access must be *associated* with a route table that contains a default route
(`0.0.0.0/0`) pointing at the Internet Gateway. Without this single line, the IGW you created is a
decorative door with no open path:

```bash
RT_ID=$(aws ec2 create-route-table --vpc-id $VPC_ID \
    --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=$ROUTE_TABLE_NAME}]" \
    --query 'RouteTable.RouteTableId' --output text)
aws ec2 create-route --route-table-id $RT_ID \
    --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
aws ec2 associate-route-table --route-table-id $RT_ID --subnet-id $SUBNET1_ID
aws ec2 associate-route-table --route-table-id $RT_ID --subnet-id $SUBNET2_ID
aws ec2 associate-route-table --route-table-id $RT_ID --subnet-id $SUBNET3_ID
```

The pattern to internalize: **VPC divides the address space, subnets place it in AZs, the IGW
connects it outward, the route table makes that connection reachable, and the security group draws
the firewall.** Every one of those decisions is made for you in real AWS console wizards — but now you
can see, and recreate, what the wizard is actually doing.

### The Real Create Flow From setup-eks.sh

The full script in `eksSetup/scripts/setup-eks.sh` runs a lot of prerequisites (Docker check, port
checks for `4566` and `6500`, the `floci-net` network, the Floci container, then all of the VPC work
above). Stripped to the EKS-specific spine, the flow is four calls:

1. **Create the cluster IAM role** so EKS is allowed to operate in your account. The role `eks-role`
   declares `eks.amazonaws.com` as a trusted entity and is granted the `AmazonEKSClusterPolicy`
   managed policy (a saved set of AWS-owned permissions; Module 07 tears the IAM model apart):

   ```bash
   aws iam create-role --role-name eks-role \
       --assume-role-policy-document '{ ... "Service":"eks.amazonaws.com" ... }'
   aws iam attach-role-policy --role-name eks-role \
       --policy-arn arn:aws:iam::aws:policy/AmazonEKSClusterPolicy
   ```

2. **Create the cluster**, handing EKS the role and the three subnet IDs in one call:

   ```bash
   aws eks create-cluster \
       --name dev-cluster \
       --role-arn arn:aws:iam::000000000000:role/eks-role \
       --resources-vpc-config subnetIds=SUBNET1,subnetIds=SUBNET2,subnetIds=SUBNET3
   ```

   Note the account `000000000000`: in the emulator there is *one fake account*, and its ARNs always
   carry that all-zeros ID.

3. **Block until the control plane is ready**:

   ```bash
   aws eks wait cluster-active --name dev-cluster
   ```

4. **Write the kubeconfig** so `kubectl` can find the cluster, then verify:

   ```bash
   aws eks update-kubeconfig --name dev-cluster --region us-east-1 --profile floci-eks
   kubectl get nodes
   ```

The script then deploys a tiny `nginx` Deployment as a smoke test and saves configuration files. If
any step fails, the script exits non-zero and points at the error documentation — exactly the
behavior you saw in the README bootstrap steps.

### Why Everything Points at localhost:4566

Every `aws` command in this course works against the real API because the AWS CLI has a single
switch that redirects it: the environment variable `AWS_ENDPOINT_URL`. `onlineBoutique/scripts/00-env.sh`
sets:

```bash
export AWS_ENDPOINT_URL="http://localhost:4566"
export AWS_DEFAULT_REGION="us-east-1"
export AWS_PROFILE="floci-eks"
export CLUSTER_NAME="dev-cluster"
```

With that variable exported, `aws eks describe-cluster`, `aws ec2 create-vpc`, and `aws iam
create-user` all become local HTTP calls to the Floci container — nothing leaves your machine. The
*same* commands against real AWS differ only by endpoint:

```text
emulated: aws ec2 describe-vpcs            -> HTTP POST to http://localhost:4566
real:     aws ec2 describe-vpcs            -> HTTPS to ec2.us-east-1.amazonaws.com
```

Notice the CLI syntax is identical. This is the core skill-transfer argument of the whole course: an
endpoint variable, not a different tool, is the whole difference between local and cloud. Delete the
variable and the next `aws` command silently targets the real AWS API (a pitfall below).

### The Floci Storage Nuance (Read This Twice)

There is one honest wart in the emulator, and it is documented in `eksSetup/Error_Documentation.md`.
The stock Floci image ships with storage mode `"memory"`, meaning the cluster's AWS-side metadata —
"there exists a cluster named `dev-cluster`, with these subnets, this role, this status" — lives only
inside the running `floci` process. The k3s container it spawned is a separate, independent process
that has no idea it is "owned".

Consequence: **do not `docker rm` the `floci` container.** If you delete it, the k3s container keeps
running happily, but the emulator forgets the cluster ever existed. You get the worst of both worlds:
a live control plane you can no longer reach through AWS APIs, and a cluster object that cannot be
described, deleted, or listed. The data-volume and network-wiring fixes in
`onlineBoutique/scripts/01-fix-floci-network.sh` deliberately keep the running container alive for
this reason. If Docker Desktop restarts, heal the network wiring; do not recreate the container.

## Hands-On Lab

All commands assume the cluster was bootstrapped per the README and that you are in the
`onlineBoutique` directory of the project. Start with the environment:

```bash
source onlineBoutique/scripts/00-env.sh
```

This exports `AWS_ENDPOINT_URL`, `AWS_DEFAULT_REGION`, `AWS_PROFILE=floci-eks`, and
`CLUSTER_NAME=dev-cluster` into your shell. Now interrogate the emulator.

**1. List clusters.** The discovery call:

```bash
aws eks list-clusters
```

Expected output:

```text
{
    "clusters": [
        "dev-cluster"
    ]
}
```

One cluster, exactly as the setup script created it.

**2. Describe the cluster object.** The metadata EKS holds about the control plane:

```bash
aws eks describe-cluster --name dev-cluster \
    --query 'cluster.{version:version,status:status,endpoint:endpoint}'
```

You should see something like:

```text
{
    "version": "1.29",
    "status": "ACTIVE",
    "endpoint": "https://localhost:6500"
}
```

`status: ACTIVE` is the control-plane contract fulfilled. Two values repay a careful look. First,
`version` echoes the version the setup script requested at creation time — it is "control-plane
metadata". Second, `endpoint` points back at your laptop: the k3s API server published on host port
`6500`, exactly as the topology diagram showed. The *real* Kubernetes version shows up where versions
are facts, not claims — at the node (`kubectl get nodes` reports `v1.34.1`).

**3. Look at the VPC you (or the script) created.** This is why tags exist:

```bash
aws ec2 describe-vpcs --filters Name=tag:Name,Values=eks-vpc*
```

Expected output contains one VPC per timestamped run, each with `CidrBlock: 10.0.0.0/16` and a
`Name` Tag like `eks-vpc-<timestamp>`. If you have run the setup more than once you may see several
— a symptom the script itself warns about at check time.

**4. See the real node.** Confirmation that "emulated cluster" still means "real Kubernetes":

```bash
kubectl get nodes
```

Expected output:

```text
NAME                     STATUS   ROLES                  AGE   VERSION
floci-eks-dev-cluster    Ready    control-plane,master   2d    v1.34.1
```

The node name mirrors the container name `floci-eks-dev-cluster`; the architecture is arm64 because
this is an Apple Silicon host. One `Ready` node is the entire worker plane — the k3s container is a
single-node cluster, so it is `control-plane` and worker at once.

**5. Inspect the system namespaces.** Real cluster machinery is running:

```bash
kubectl get pods -n kube-system
```

Expected output shows the standard k3s plumbing — names will carry generated suffixes:

```text
NAME                                          READY   STATUS    RESTARTS   AGE
coredns-<full-hash>                           1/1     Running   0          2d
local-path-provisioner-<full-hash>            1/1     Running   0          2d
metrics-server-<full-hash>                    1/1     Running   0          2d
```

`coredns` (cluster DNS, Module 05), `local-path-provisioner` (the default StorageClass that makes
PersistentVolumeClaims work locally), and `metrics-server` (the resource meter Module 09 uses) are
the telltale signs of healthy k3s — not a mock.

**6. Observe how kubectl reached the cluster.** Peel back the kubeconfig the earlier modules wrote:

```bash
kubectl config view --minify
```

You will see a cluster entry with `server: https://localhost:6500` and a user whose authentication
is an `exec` block. The next module live-sections exactly what that block does and why it exists.

## Common Pitfalls

- **Endpoint URL wrong -> hitting real AWS.** Without `AWS_ENDPOINT_URL=http://localhost:4566`
  exported (or the `endpoint_url` set in your `floci-eks` profile), `aws eks` calls silently target
  the real AWS API — with your *real* default credentials, against a *real* account, creating
  chargeable resources. This is the emulator's sharpest edge. If a command takes longer than a
  second or asks about an account you do not recognize, your endpoint is wrong. Check with
  `echo $AWS_ENDPOINT_URL`.
- **Floci stopped -> API down but cluster container still up.** The `floci` container and the
  `floci-eks-dev-cluster` container are independent processes. Stop Floci (or reboot Docker Desktop
  without it auto-starting) and `aws eks describe-cluster` returns connection errors while
  `docker ps` still shows k3s running. Start Floci back up on port `4566`; the cluster metadata
  returns because it was never lost — it was sleeping.
- **Destroying the Floci container -> orphaned cluster.** Revisit the storage-memory nuance above.
  `docker rm -f floci` while keeping the k3s container alive creates an unreachable control plane
  with no API-side record of it. Clean up with the project's scripts, which are written to respect
  this.
- **Ignoring the network wiring.** If you create the `floci` container on the default `bridge`
  network, container-name DNS disappears and ECR pushes break with `503`. Always use `floci-net`
  and the `FLOCI_SERVICES_*_DOCKER_NETWORK` variables, or re-run
  `onlineBoutique/scripts/01-fix-floci-network.sh`.

## Key Takeaways

- EKS is a managed Kubernetes service: AWS runs the api-server/etcd control plane; you supply VPC,
  subnets, and a node IAM role.
- The five EKS objects to recognize are the cluster, the nodegroup, the Fargate profile, addons, and
  access entries — real deployments use all of them, this lab uses only a cluster.
- VPC, IGW, subnets, security groups, and route tables are not EKS; they are the AWS substrate EKS
  must sit on, and the setup script builds each with a single public CLI call.
- Floci's EKS "real mode" launches a rancher/k3s container per cluster, so `dev-cluster` is a real
  Kubernetes cluster (k3s v1.34.1) reachable at `https://localhost:6500`.
- The complete difference between this emulator and real AWS is one variable: the endpoint at
  `http://localhost:4566`. The CLI knowledge transfers 1:1 to the cloud.
- Floci keeps cluster metadata in memory; protect the `floci` container itself and heal networking
  in place rather than recreating it.

## Review Questions

1. What does Amazon EKS manage for you, and what must you supply?
2. Name all five key EKS objects and say which ones this lab's setup creates.
3. Why does the setup script create a VPC, subnets in three availability zones, an Internet Gateway,
   and a route table with a `0.0.0.0/0` default route before it ever creates the cluster?
4. How is `dev-cluster` a real Kubernetes cluster rather than a simulation?
5. What is the purpose of `AWS_ENDPOINT_URL=http://localhost:4566`, and what happens if it is unset?
6. Why must you not delete the `floci` container even though the config lives in `floci-data`?

### Answers

1. AWS runs and maintains the control plane (api-server, etcd, scheduler, controllers, upgrades).
   You supply the VPC/subnet topology, the node IAM role, and the security group rules.
2. Cluster, nodegroup, Fargate profile, addon, access entry. This lab creates only a `cluster` object;
   the single worker node is the k3s container, not a managed nodegroup, and no addon/profile/access
   entry objects are created.
3. EKS is a network citizen: its control plane and nodes must live in a private address space
   (VPC), spread across AZs for availability (subnets), reach the internet (IGW + default route),
   and be firewalled (security group port 6443 for the API server).
4. Floci's EKS real mode launches a rancher/k3s container. The `floci-eks-dev-cluster` container runs
   the full Kubernetes control plane and worker on one arm64 node (`kubectl get nodes` shows one
   `Ready` node, version `v1.34.1`), with real `coredns`, `metrics-server`, and
   `local-path-provisioner` Pods in `kube-system`.
5. It redirects every `aws` CLI call from the real AWS service endpoints to the local emulator at
   port 4566. If unset, the CLI targets real AWS — a dangerous and, on this machine, unintended
   behavior.
6. The stock Floci image uses in-memory storage, so cluster metadata (`dev-cluster` and its
   configuration) lives only in the running `floci` process. Removing the container loses that
   metadata while leaving the orphaned k3s container running — a state no AWS API can repair.