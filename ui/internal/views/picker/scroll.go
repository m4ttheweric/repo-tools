package picker

// defaultCap is the viewport height used when a caller sets no cap (cap_==0):
// enough rows to read as a real list without a short pane's chrome ever
// getting squeezed off a typical terminal.
const defaultCap = 14

// scrolloff mirrors vim's: the cursor stays this many rows from the visible
// top/bottom edge whenever the window is tall enough to afford it.
const scrolloff = 2

// scrollMargin shrinks scrolloff symmetrically once a window is too short to
// afford it on both edges at once -- shared by placeTop (keyboard/cursor
// scrolling) and mouse.go's wheel handler, which has to predict this same
// margin to know whether a wheel-scrolled top will hold on the next render
// or get immediately overridden by placeTop re-centering on the cursor.
func scrollMargin(h int) int {
	off := scrolloff
	if lim := (h - 1) / 2; lim < off {
		off = lim
	}
	return off
}

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
	return placeTop(cursor, top, n, h), h
}

// placeTop positions a window's top edge for an already-decided height h so
// the cursor keeps scrolloff rows of margin from both visible edges
// wherever h affords it, shrinking that margin symmetrically only when h is
// too short to hold scrolloff on both sides at once. Factored out of
// Viewport so a caller that needs to try several candidate heights (the
// header budget trim shrinks h to make room for header lines) can re-derive
// a scrolloff-correct top for each candidate instead of inheriting whatever
// top Viewport happened to compute for its own, larger h.
func placeTop(cursor, prevTop, n, h int) int {
	if h <= 0 || n <= 0 {
		return 0
	}
	if cursor < 0 {
		cursor = 0
	}
	if cursor >= n {
		cursor = n - 1
	}

	maxTop := n - h
	if maxTop < 0 {
		maxTop = 0
	}
	top := prevTop
	if top < 0 {
		top = 0
	}
	if top > maxTop {
		top = maxTop
	}

	off := scrollMargin(h)

	switch pos := cursor - top; {
	case pos < off:
		top = cursor - off
	case pos > h-1-off:
		top = cursor - (h - 1 - off)
	}
	if top < 0 {
		top = 0
	}
	if top > maxTop {
		top = maxTop
	}
	return top
}
