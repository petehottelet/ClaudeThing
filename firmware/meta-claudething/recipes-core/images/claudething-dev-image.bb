SUMMARY = "ClaudeThing development image"
DESCRIPTION = "ClaudeThing dashboard firmware with diagnostic tools for owned-device bring-up."
LICENSE = "MIT"

require claudething-image-base.inc

IMAGE_INSTALL:append = " packagegroup-claudething-dev"
