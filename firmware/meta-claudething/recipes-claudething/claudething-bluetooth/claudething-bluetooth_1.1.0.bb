SUMMARY = "ClaudeThing authenticated Bluetooth snapshot transport"
DESCRIPTION = "Receives signed dashboard snapshots over encrypted Bluetooth RFCOMM and provides a time-limited pairing window."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = " \
    file://claudething-bluetooth-receiver.c \
    file://claudething-bluetooth.service \
    file://claudething-bluetooth-pairing \
    file://claudething-bluetooth-pairing.service \
"

S = "${UNPACKDIR}"
DEPENDS = "bluez5 openssl"

inherit systemd

SYSTEMD_SERVICE:${PN} = "claudething-bluetooth.service"
SYSTEMD_AUTO_ENABLE:${PN} = "enable"

do_compile() {
    ${CC} ${CFLAGS} ${CPPFLAGS} \
        ${S}/claudething-bluetooth-receiver.c \
        -o claudething-bluetooth-receiver \
        ${LDFLAGS} -lbluetooth -lcrypto
}

do_install() {
    install -d ${D}${sbindir} ${D}${libexecdir} ${D}${systemd_system_unitdir}
    install -m 0755 claudething-bluetooth-receiver ${D}${sbindir}/claudething-bluetooth-receiver
    install -m 0755 ${S}/claudething-bluetooth-pairing ${D}${libexecdir}/claudething-bluetooth-pairing
    install -m 0644 ${S}/claudething-bluetooth.service ${D}${systemd_system_unitdir}/claudething-bluetooth.service
    install -m 0644 ${S}/claudething-bluetooth-pairing.service ${D}${systemd_system_unitdir}/claudething-bluetooth-pairing.service
}

FILES:${PN} += " \
    ${sbindir}/claudething-bluetooth-receiver \
    ${libexecdir}/claudething-bluetooth-pairing \
    ${systemd_system_unitdir}/claudething-bluetooth.service \
    ${systemd_system_unitdir}/claudething-bluetooth-pairing.service \
"

RDEPENDS:${PN} += "bluez5"
