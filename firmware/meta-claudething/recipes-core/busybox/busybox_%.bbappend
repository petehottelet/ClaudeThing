FILESEXTRAPATHS:prepend := "${THISDIR}/${BPN}:"

# The ClaudeThing dashboard is served locally by BusyBox httpd. The base
# configuration disables that applet, so enable only the small HTTP server;
# CGI, proxying, authentication, and other network-facing features stay off.
SRC_URI += "file://claudething-httpd.cfg"
