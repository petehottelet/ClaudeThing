inherit core-image
inherit mainline-flashthing
inherit superbird-headroom-check
inherit superbird-image

IMAGE_FEATURES += "ssh-server-openssh post-install-logging"

IMAGE_INSTALL = " \
    packagegroup-core-boot \
    packagegroup-claudething-runtime \
"

BAD_RECOMMENDATIONS += "kernel-modules udev-hwdb wpa-supplicant wireless-regdb wireless-regdb-static weston-init"

SUPERBIRD_ROOTFS_TYPE ??= "ext4"
EXTRA_IMAGECMD:ext4 = "-i 16384 -m 0 -O ^has_journal -O ^huge_file"

IMAGE_FSTYPES = "wic ${SUPERBIRD_ROOTFS_TYPE}"
WKS_FILE = "superbird-mainline.wks.in"

do_image_wic[depends] += " \
    virtual/kernel:do_deploy \
    superbird-uenv:do_deploy \
    superbird-extlinux:do_deploy \
    superbird-logo:do_deploy \
"

EXTRA_IMAGEDEPENDS += "superbird-uboot"
