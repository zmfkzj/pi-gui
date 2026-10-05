#!/usr/bin/env python3
"""A minimal GTK 3 text editor for pi-gui's live tests: one window, one multi-line text area. GTK 3 exports AT-SPI
through its ATK bridge on the private accessibility bus (GTK 4 apps currently do not: upstream's runner sets an invalid
GTK_A11Y value)."""
import sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

title = sys.argv[1] if len(sys.argv) > 1 else "pi-gui test editor"
window = Gtk.Window(title=title)
window.set_default_size(900, 600)
view = Gtk.TextView()
view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
view.get_accessible().set_name("document")
scroller = Gtk.ScrolledWindow()
scroller.add(view)
window.add(scroller)
window.connect("destroy", Gtk.main_quit)
window.show_all()
view.grab_focus()
Gtk.main()
