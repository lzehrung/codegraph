variable "region" {
  type = string
}

# @def subnet_id @coverage subnet_id complete
output "subnet_id" {
  value = var.region
}

# @def vpc_id @coverage vpc_id complete
output "vpc_id" {
  value = "vpc-${var.region}"
}
