#!/usr/bin/env bash

# run_step "Install DISTRHO Ports packages" apt_install_available dpf-plugins
# run_step "Install Tyrell N6" install_tyrell_n6
# run_step "Install OB-Xd" install_obxd
# TYRELL_PRIMARY_URL="commented"
# obxd_target_version="commented"

printf '%s\n' 'run_step "Install DISTRHO Ports packages" apt_install_available dpf-plugins'
printf '%s\n' 'run_step "Install Tyrell N6" install_tyrell_n6'
printf '%s\n' 'run_step "Install OB-Xd" install_obxd'
printf '%s\n' 'TYRELL_PRIMARY_URL="quoted"'
printf '%s\n' 'obxd_target_version="quoted"'

cat <<'TEXT'
run_step "Install DISTRHO Ports packages" apt_install_available dpf-plugins
run_step "Install Tyrell N6" install_tyrell_n6
run_step "Install OB-Xd" install_obxd
TYRELL_PRIMARY_URL="heredoc"
obxd_target_version="heredoc"
TEXT

run_step "Install DISTRHO Ports packages" apt_install_available dpf-plugins
run_step "Install Tyrell N6" install_tyrell_n6
run_step "Install OB-Xd" install_obxd
local TYRELL_PRIMARY_URL="https://example.invalid/TyrellN6.tar.xz"
local obxd_target_version="2.17.0"
