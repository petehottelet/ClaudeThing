SUMMARY = "ClaudeThing device runtime"
DESCRIPTION = "Hardware runtime, compositor, Chromium kiosk, and the ClaudeThing local dashboard service."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

inherit packagegroup

PACKAGES = "${PN}"

RDEPENDS:${PN} = " \
    packagegroup-superbird-runtime \
    claudething-ui \
    claudething-bluetooth \
    mesa \
    weston \
    blank-cursor \
    cursor-suppress \
    superbird-fbpaint \
    superbird-weston-init-kiosk \
    chromium-ozone-wayland \
    chromium-kiosk \
"
