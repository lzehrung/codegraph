locals {
  name_prefix = "${var.region}-app"
  tags        = { Name = local.name_prefix }
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

resource "aws_instance" "web" {
  count         = 2
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.micro"
  tags          = merge(local.tags, { Index = count.index })
  subnet_id     = module.network.subnet_id
  depends_on    = [aws_s3_bucket.logs]

  lifecycle {
    ignore_changes = [tags]
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "${local.name_prefix}-logs"
}

module "network" {
  source = "./modules/network"
  cidr   = var.cidr
  region = var.region
}

module "storage" {
  source = "./modules/storage"
  region = var.region
}

module "consul" {
  source  = "hashicorp/consul/aws"
  version = "0.1.0"
}
