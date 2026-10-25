# @def plainName=name
variable "name" {}

# @def hyphenatedName=name-other
variable "name-other" {}

# @def commentRegion=comment_region
variable "comment_region" /* block label comment */ {}

module "counted_network" {
  count  = 1
  source = "./modules/network"
  region = var.region
}

module "for_each_network" {
  for_each = var.instances
  source   = "./modules/network"
  region   = var.region
}

module "commented_network" {
  source /* source comment */ = "./modules/network"
  region = var.region
}

locals {
  hyphenated_value = var.name-other // @goto hyphenatedName=name-other @not-ref plainName
  commented_region = var /* traversal comment */ .region // @ref region @goto region=region
  count_output = module.counted_network[*].vpc_id // @ref vpc_id
  keyed_output = module.for_each_network["primary"].settings // @ref moduleSettings
  keyed_module = module.for_each_network["primary"].vpc_id // @ref vpc_id
  commented_source = module.commented_network.vpc_id // @ref vpc_id
}

import {
  to = module.network.aws_instance.web // @not-ref decoyAwsInstance
  id = "import-id"
}
