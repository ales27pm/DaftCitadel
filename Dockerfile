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

RUN if ! getent group ${TARGET_GID} > /dev/null; then \
        groupadd -g ${TARGET_GID} ${TARGET_USER}; \
    fi \
    && if id -u ${TARGET_USER} > /dev/null 2>&1; then \
        usermod -u ${TARGET_UID} -g ${TARGET_GID} -s /bin/bash ${TARGET_USER}; \
        usermod -d /home/${TARGET_USER} -m ${TARGET_USER}; \
    else \
        useradd -m -u ${TARGET_UID} -g ${TARGET_GID} -s /bin/bash ${TARGET_USER}; \
    fi \
    && usermod -a -G sudo ${TARGET_USER} \
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
