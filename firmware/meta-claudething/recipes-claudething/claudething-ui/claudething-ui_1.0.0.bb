SUMMARY = "ClaudeThing dashboard bundle and local HTTP service"
DESCRIPTION = "Installs the independently authored ClaudeThing web application and serves it on loopback for the kiosk browser."
HOMEPAGE = "https://github.com/petehottelet/ClaudeThing"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = " \
    file://bundle \
    file://claudething-ui.service \
    file://claudething-ui-start \
"

S = "${UNPACKDIR}"

inherit allarch systemd

SYSTEMD_SERVICE:${PN} = "claudething-ui.service"
SYSTEMD_AUTO_ENABLE:${PN} = "enable"

RDEPENDS:${PN} += "busybox"

do_install() {
    install -d ${D}${datadir}/claudething/ui
    cp -R --no-preserve=ownership ${S}/bundle/. ${D}${datadir}/claudething/ui/

    install -d ${D}${bindir}
    install -m 0755 ${S}/claudething-ui-start ${D}${bindir}/claudething-ui-start

    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${S}/claudething-ui.service ${D}${systemd_system_unitdir}/claudething-ui.service
}

FILES:${PN} += "${datadir}/claudething/ui"
