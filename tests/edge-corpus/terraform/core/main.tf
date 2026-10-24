# @def region @coverage region complete
variable "region" {
  type = string
}

# @def instances @coverage instances complete
variable "instances" {
  type = map(string)
}

locals {
  # @def prefix @coverage prefix complete
  prefix = "${var.region}-edge"
}

# @def ubuntu @coverage ubuntu complete
data "aws_ami" "ubuntu" {
  most_recent = true
}

# @def web @coverage web complete
resource "aws_instance" "web" {
  for_each = var.instances
  ami           = data.aws_ami.ubuntu.id
  instance_type = each.value
  tags          = { Name = "${local.prefix}-${each.key}" }
}

# @def network @coverage network complete
module "network" {
  source = "./modules/network"
  region = var.region
}

locals {
  # @goto region=region @ref region
  another_name = var.region
  # @goto prefix=prefix @ref prefix
  use_prefix = local.prefix
  # @goto ubuntu=ubuntu @ref ubuntu
  image_id = data.aws_ami.ubuntu.id
  # @goto web=web @ref web
  instance_id = aws_instance.web.id
  # @goto network=network @ref network
  subnet = module.network.subnet_id
  # @goto subnet_id=subnet_id @ref subnet_id
  subnet_value = module.network.subnet_id
  # @goto vpc_id=vpc_id @ref vpc_id
  vpc = module.network.vpc_id
}

locals {
  quoted_decoy = "var.region" # @not-ref region
}

# @not-ref-block region
locals {
  heredoc_decoy = <<-EOT
var.region
local.prefix
EOT
}

locals {
  plain_module_text = "module.network.output" # @not-ref network
}
