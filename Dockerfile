FROM ubuntu:24.04

ARG TARGET_USER=daftpunk
ARG TARGET_UID=1000
ARG TARGET_GID=1000
ARG PROFILE=citadel

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        sudo \
        locales \
        curl \
        ca-certificates \
        git \
        unzip \
        gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN locale-gen en_US.UTF-8

RUN set -euo pipefail \
    && target_home="/home/${TARGET_USER}" \
    && existing_group_gid="$(getent group "${TARGET_USER}" | cut -d: -f3 || true)" \
    && if [ -n "${existing_group_gid}" ]; then \
        if [ "${existing_group_gid}" != "${TARGET_GID}" ]; then \
            echo "Group '${TARGET_USER}' already exists with GID ${existing_group_gid}, expected ${TARGET_GID}" >&2; \
            exit 1; \
        fi; \
    else \
        existing_group_name="$(getent group "${TARGET_GID}" | cut -d: -f1 || true)"; \
        if [ -n "${existing_group_name}" ]; then \
            echo "GID ${TARGET_GID} already in use by group '${existing_group_name}'" >&2; \
            exit 1; \
        fi; \
        groupadd -g "${TARGET_GID}" "${TARGET_USER}"; \
    fi \
    && if id -u "${TARGET_USER}" > /dev/null 2>&1; then \
        existing_uid="$(id -u "${TARGET_USER}")"; \
        if [ "${existing_uid}" != "${TARGET_UID}" ]; then \
            uid_owner="$(getent passwd "${TARGET_UID}" | cut -d: -f1 || true)"; \
            if [ -n "${uid_owner}" ] && [ "${uid_owner}" != "${TARGET_USER}" ]; then \
                echo "UID ${TARGET_UID} already in use by user '${uid_owner}'" >&2; \
                exit 1; \
            fi; \
        fi; \
        usermod -u "${TARGET_UID}" -g "${TARGET_GID}" -s /bin/bash "${TARGET_USER}"; \
        current_home="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"; \
        if [ "${current_home}" != "${target_home}" ]; then \
            if [ -d "${target_home}" ]; then \
                target_owner="$(stat -c %U "${target_home}" 2>/dev/null || true)"; \
                if [ -n "${target_owner}" ] && [ "${target_owner}" != "${TARGET_USER}" ]; then \
                    echo "Home directory ${target_home} already exists and is owned by '${target_owner}'" >&2; \
                    exit 1; \
                fi; \
            fi; \
            usermod -d "${target_home}" -m "${TARGET_USER}"; \
        fi; \
    else \
        if getent passwd "${TARGET_UID}" > /dev/null; then \
            uid_owner="$(getent passwd "${TARGET_UID}" | cut -d: -f1)"; \
            if [ "${uid_owner}" != "${TARGET_USER}" ]; then \
                echo "UID ${TARGET_UID} already in use by user '${uid_owner}'" >&2; \
                exit 1; \
            fi; \
        fi; \
        useradd -m -u "${TARGET_UID}" -g "${TARGET_GID}" -s /bin/bash "${TARGET_USER}"; \
    fi \
    && usermod -a -G sudo "${TARGET_USER}" \
    && echo "${TARGET_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${TARGET_USER}

WORKDIR /workspace
COPY . /workspace
RUN chmod +x scripts/daftcitadel.sh

RUN /workspace/scripts/daftcitadel.sh \
      --profile=${PROFILE} \
      --auto \
      --gpu-off \
      --container \
      --user=${TARGET_USER}

USER ${TARGET_USER}
ENV CITADEL_HOME=/home/${TARGET_USER}/DaftCitadel
WORKDIR /home/${TARGET_USER}

ENTRYPOINT ["/bin/bash"]
