# Same declaration names as modules/network; references in other modules must not reach these.
variable "region" {
  type = string
}

resource "aws_vpc" "main" {
  cidr_block = "10.1.0.0/16"
}

output "vpc_id" {
  value = aws_vpc.main.id
}
