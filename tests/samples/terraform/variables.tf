variable "region" {
  type    = string
  default = "us-east-1"
}

variable "cidr" {
  type = string
}

# Same name as the managed resource aws_instance.web; it must stay a separate symbol.
variable "web" {
  type    = string
  default = "web"
}
