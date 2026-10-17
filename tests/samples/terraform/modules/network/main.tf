resource "aws_vpc" "main" {
  cidr_block = var.cidr
  tags       = { Region = var.region }
}

resource "aws_subnet" "main" {
  vpc_id     = aws_vpc.main.id
  cidr_block = cidrsubnet(var.cidr, 8, 0)
}
