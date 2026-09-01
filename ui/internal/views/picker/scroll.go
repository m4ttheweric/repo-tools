package picker

// defaultCap is the viewport height used when a caller sets no cap (cap_==0):
// enough rows to read as a real list without a short pane's chrome ever
// getting squeezed off a typical terminal.
const defaultCap = 14

// scrolloff mirrors vim's: the cursor stays this many rows from the visible
// top/bottom edge whenever the window is tall enough to afford it.
const scrolloff = 2

// Viewport returns [top, top+h) given cursor, list length, caller cap, pane
// rows, chrome rows. The pane is always the hard ceiling on h: a caller cap
// or a long list can ask for more rows than the terminal actually has, and
// the picker must fit inside the pane rather than paint rows the terminal
// will just truncate or scroll away from under it.
func Viewport(cursor, top, n, cap_, paneRows, chromeRows int) (newTop, h int) {
	if cap_ <= 0 {
		cap_ = defaultCap
	}
	h = cap_
	if n < h {
		h = n
	}
	if ceiling := paneRows - chromeRows; ceiling < h {
		h = ceiling
	}
	if h < 0 {
		h = 0
	}
	if h == 0 || n == 0 {
		return 0, h
	}

	if cursor < 0 {
		cursor = 0
	}
	if cursor >= n {
		cursor = n - 1
	}

	maxTop := n - h
	newTop = top
	if newTop < 0 {
		newTop = 0
	}
	if newTop > maxTop {
		newTop = maxTop
	}

	// A window shorter than 2*scrolloff+1 can't hold the cursor scrolloff
	// rows from both edges at once; shrink the margin symmetrically rather
	// than let one edge claim it all.
	off := scrolloff
	if lim := (h - 1) / 2; lim < off {
		off = lim
	}

	switch pos := cursor - newTop; {
	case pos < off:
		newTop = cursor - off
	case pos > h-1-off:
		newTop = cursor - (h - 1 - off)
	}
	if newTop < 0 {
		newTop = 0
	}
	if newTop > maxTop {
		newTop = maxTop
	}
	return newTop, h
}
