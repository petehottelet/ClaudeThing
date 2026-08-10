SUMMARY = "ClaudeThing device diagnostics"
DESCRIPTION = "Interactive diagnostics included only in the development firmware image."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

inherit packagegroup

PACKAGES = "${PN}"

RDEPENDS:${PN} = " \
    bash \
    coreutils \
    evtest \
    htop \
    i2c-tools \
    iproute2 \
    strace \
    tcpdump \
    wayland-utils \
"
