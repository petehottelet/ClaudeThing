FILESEXTRAPATHS:prepend := "${THISDIR}/files:"

SRC_URI += " \
    file://20-claudething.conf \
    file://claudething-ui-ready \
"

do_install:append() {
    install -d ${D}${systemd_system_unitdir}/chromium-kiosk.service.d
    install -m 0644 ${UNPACKDIR}/20-claudething.conf \
        ${D}${systemd_system_unitdir}/chromium-kiosk.service.d/20-claudething.conf
    install -m 0755 ${UNPACKDIR}/claudething-ui-ready ${D}${bindir}/claudething-ui-ready
}

FILES:${PN} += " \
    ${systemd_system_unitdir}/chromium-kiosk.service.d/20-claudething.conf \
    ${bindir}/claudething-ui-ready \
"
