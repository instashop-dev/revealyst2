# Reference IaC for the Revealyst RDS PostgreSQL instance.
#
# The live deploy pipeline (`.github/workflows/deploy.yml`) provisions the same
# configuration via the AWS CLI (idempotent, no state file, password held in
# AWS Secrets Manager) — chosen because this repository is public and a
# local-backend state file would leak secrets into git history.
#
# To adopt this module for production (private repo or remote backend):
#   1. Add a private backend (S3 + DynamoDB lock, or Terraform Cloud).
#   2. Create the secret first:
#        aws secretsmanager create-secret --name revealyst/db-password \
#          --secret-string "$(openssl rand -base64 24)"
#   3. terraform init && terraform apply -var 'db_password_secret=revealyst/db-password'
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "db_password_secret" {
  type        = string
  default     = "revealyst/db-password"
  description = "Name of the AWS Secrets Manager secret holding the DB password"
}

variable "db_name" {
  type    = string
  default = "revealyst"
}

variable "db_username" {
  type    = string
  default = "revealyst"
}

data "aws_secretsmanager_secret_version" "db_password" {
  secret_id = var.db_password_secret
}

# Workers egress IPs are shared infrastructure, so the instance is reachable
# from anywhere and protected by a strong random password. Production
# hardening: restrict to a NAT/egress IP range or move Workers behind
# Cloudflare Hyperdrive (see docs/runbook.md).
resource "aws_security_group" "revealyst_rds" {
  name_prefix = "revealyst-rds-"

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "revealyst" {
  identifier          = "revealyst"
  engine              = "postgres"
  engine_version      = "15.7"
  instance_class      = "db.t3.micro"
  allocated_storage   = 20
  storage_encrypted   = true
  db_name             = var.db_name
  username            = var.db_username
  password            = data.aws_secretsmanager_secret_version.db_password.secret_string
  publicly_accessible = true
  skip_final_snapshot = true
  vpc_security_group_ids = [aws_security_group.revealyst_rds.id]
  backup_retention_period = 7
  deletion_protection     = false # enable once stable
  tags = {
    Name    = "revealyst"
    Service = "revealyst"
  }
}

output "rds_endpoint" {
  value = aws_db_instance.revealyst.endpoint
}
