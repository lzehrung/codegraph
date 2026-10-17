output "instance_ids" {
  value = aws_instance.web[*].id
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "private_ips" {
  value = [for web in aws_instance.web : web.private_ip]
}

# A registry module is installed by `terraform init`, so its outputs are not indexed.
output "consul_ui" {
  value = module.consul.ui_url
}

output "vpc_ids" {
  value = module.network[*].vpc_id
}
