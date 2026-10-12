// Minimal ext-data-control reader: reads the clipboard selection as soon as it changes (what krdp's KSystemClipboard
// does for a connected RDP client). Prints one line per read.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>
#include <time.h>
#include <wayland-client.h>
#include "ext-data-control-v1-client.h"
static struct ext_data_control_manager_v1 *mgr; static struct wl_seat *seat; static struct wl_display *dpy;
static int has_text;
static void offer_offer(void *d, struct ext_data_control_offer_v1 *o, const char *mime) { if (!strcmp(mime, "text/plain;charset=utf-8") || !strcmp(mime, "text/plain")) has_text = 1; }
static const struct ext_data_control_offer_v1_listener offer_l = { offer_offer };
static void dev_offer(void *d, struct ext_data_control_device_v1 *dev, struct ext_data_control_offer_v1 *o) { has_text = 0; ext_data_control_offer_v1_add_listener(o, &offer_l, NULL); }
static void dev_selection(void *d, struct ext_data_control_device_v1 *dev, struct ext_data_control_offer_v1 *o) {
  if (!o) { printf("selection cleared\n"); fflush(stdout); return; }
  int fds[2]; if (pipe(fds)) return;
  ext_data_control_offer_v1_receive(o, "text/plain;charset=utf-8", fds[1]); close(fds[1]); wl_display_flush(dpy);
  char buf[4096]; size_t n = 0; struct pollfd p = { fds[0], POLLIN, 0 }; time_t start = time(NULL);
  for (;;) { int r = poll(&p, 1, 1000); if (r > 0) { ssize_t k = read(fds[0], buf + n, sizeof buf - 1 - n); if (k <= 0) break; n += k; if (n >= sizeof buf - 1) break; } else if (time(NULL) - start > 10) { printf("read timed out\n"); break; } }
  buf[n] = 0; close(fds[0]); printf("read %zu bytes: %.60s\n", n, buf); fflush(stdout);
}
static void dev_finished(void *d, struct ext_data_control_device_v1 *dev) {}
static void dev_primary(void *d, struct ext_data_control_device_v1 *dev, struct ext_data_control_offer_v1 *o) {}
static const struct ext_data_control_device_v1_listener dev_l = { dev_offer, dev_selection, dev_finished, dev_primary };
static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t v) {
  if (!strcmp(iface, ext_data_control_manager_v1_interface.name)) mgr = wl_registry_bind(r, name, &ext_data_control_manager_v1_interface, 1);
  else if (!strcmp(iface, "wl_seat") && !seat) seat = wl_registry_bind(r, name, &wl_seat_interface, 1);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t name) {}
static const struct wl_registry_listener reg_l = { reg_global, reg_remove };
int main(void) {
  dpy = wl_display_connect(NULL); if (!dpy) { fprintf(stderr, "no display\n"); return 1; }
  struct wl_registry *reg = wl_display_get_registry(dpy); wl_registry_add_listener(reg, &reg_l, NULL); wl_display_roundtrip(dpy);
  if (!mgr || !seat) { fprintf(stderr, "no ext_data_control_manager_v1 (%p) or seat (%p)\n", (void*)mgr, (void*)seat); return 2; }
  struct ext_data_control_device_v1 *dev = ext_data_control_manager_v1_get_data_device(mgr, seat);
  ext_data_control_device_v1_add_listener(dev, &dev_l, NULL);
  printf("ready\n"); fflush(stdout);
  while (wl_display_dispatch(dpy) != -1) {}
  return 0;
}
