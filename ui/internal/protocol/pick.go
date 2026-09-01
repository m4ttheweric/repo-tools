package protocol

import (
	"encoding/json"
	"fmt"
)

// Pick messages. TS drives the picker's content (pick opens it, update
// pushes enriched rows, modal opens a submenu); Go reports what the user did
// (event mid-session, modal-result, result on close). Only PickRequest opens
// a fresh stream, so only it carries protocol -- the rest ride an already
// negotiated connection, same as session's Open/Model vs Hello.

type PickSegment struct {
	Text string `json:"text"`
	Tone string `json:"tone,omitempty"`
	Hex  string `json:"hex,omitempty"`
	Bold bool   `json:"bold,omitempty"`
}

type PickRow struct {
	Value string        `json:"value"`
	Left  []PickSegment `json:"left"`
	Right []PickSegment `json:"right,omitempty"`
	Match string        `json:"match,omitempty"`
	Group string        `json:"group,omitempty"`
	// WithArgs marks a row whose primary action can run with extra
	// arguments -- render.go's alt-held with-args header badge, cursor-row
	// badge, and per-row dim all key off this. showPicker
	// (lib/command-tree.ts) is the only setter on the wire.
	WithArgs bool `json:"withArgs,omitempty"`
}

type PickAction struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Key     string `json:"key,omitempty"`
	Scope   string `json:"scope"`
	Group   string `json:"group,omitempty"`
	Primary bool   `json:"primary,omitempty"`
	// Event, true: the picker stays open and reports a PickEvent; false or
	// absent: it closes with a PickResult. Omitempty so a request built
	// without any event actions round-trips without ever mentioning the
	// field, matching every other boolean flag on this struct.
	Event bool `json:"event,omitempty"`
	// MenuHidden marks an action that the picker itself synthesizes for a
	// hardcoded key (never decoded off the wire, so json:"-" -- a caller's
	// own request can never set or see it): it still renders in the footer
	// keybar, but deriveMenu excludes it from the ctrl-k/right-click menu,
	// since selecting it there would dispatch through the generic registry
	// path instead of the hardcoded handler that key actually runs.
	MenuHidden bool `json:"-"`
	// FooterHidden keeps an action bound and dispatchable but out of the
	// footer keybar legend: the command-tree root sets it on the ctrl-up back
	// action so that key still cancels while no bare "ctrl-up" advertises a
	// back with nowhere to go. Unlike MenuHidden this rides the wire (showPicker
	// sets it), so it carries a json tag; omitempty keeps every other request
	// byte-identical.
	FooterHidden bool `json:"footerHidden,omitempty"`
}

type PickRequest struct {
	T             string       `json:"t"`
	Protocol      int          `json:"protocol"`
	Message       string       `json:"message"`
	Breadcrumb    []string     `json:"breadcrumb,omitempty"`
	Rows          []PickRow    `json:"rows"`
	Actions       []PickAction `json:"actions,omitempty"`
	Multi         bool         `json:"multi,omitempty"`
	InitialValues []string     `json:"initialValues,omitempty"`
	InitialQuery  string       `json:"initialQuery,omitempty"`
	ResumeValue   string       `json:"resumeValue,omitempty"`
	Exact         bool         `json:"exact,omitempty"`
	Cap           int          `json:"cap,omitempty"`
	SelectedPanel bool         `json:"selectedPanel,omitempty"`
	// IdleCount is the count-slot text painted faint while the query is empty,
	// standing in for the generic match fraction -- nav's "N folders · M
	// files". A non-empty query falls back to the cyan matched-count. nav is
	// the only setter; every other surface omits it and keeps the fraction.
	IdleCount string `json:"idleCount,omitempty"`
	// CrumbSuffix is a faint run painted after the bold breadcrumb segments --
	// nav's non-default sort suffix, which must read faint rather than inherit
	// the breadcrumb's uniform bold. Replaced wholesale with the Breadcrumb it
	// annotates (see applyUpdate), so an update omitting it clears it.
	CrumbSuffix string `json:"crumbSuffix,omitempty"`
	// CrumbEvents opts into a breadcrumb segment click emitting a
	// {action:"crumb", value:"<segment index>"} event; without it a click on
	// the breadcrumb is inert, since a caller that never wired a listener
	// for it would otherwise have no way to know a crumb click happened.
	CrumbEvents bool `json:"crumbEvents,omitempty"`
	// AcceptNoMatch: enter on a no-match filter resolves with
	// {action:"select", value:null, query} instead of leaving the picker open.
	AcceptNoMatch bool `json:"acceptNoMatch,omitempty"`
}

type PickUpdate struct {
	T       string       `json:"t"`
	Rows    []PickRow    `json:"rows,omitempty"`
	Message string       `json:"message,omitempty"`
	Actions []PickAction `json:"actions,omitempty"`
	// Breadcrumb replaces the rendered header (render.go's breadcrumbLine
	// reads it, not Message) on an in-place row swap -- e.g. nav's descend/up
	// keeping the header's cwd path current without a close+reopen.
	Breadcrumb []string `json:"breadcrumb,omitempty"`
	// IdleCount patches the empty-query count slot -- nav supplies its "N
	// folders · M files" on every rows update. See PickRequest.IdleCount.
	IdleCount string `json:"idleCount,omitempty"`
	// CrumbSuffix patches the faint breadcrumb suffix. It rides with the
	// Breadcrumb it annotates -- an update carrying a Breadcrumb but no
	// CrumbSuffix clears the suffix (nav returning to the default sort). See
	// PickRequest.CrumbSuffix.
	CrumbSuffix string `json:"crumbSuffix,omitempty"`
	// ResetQuery clears the typed query and re-ranks against the (possibly
	// also-patched) rows, same as a fresh directory's first render -- e.g.
	// nav's descend/up, where a filter typed in the parent must not carry
	// into a child it may not match at all.
	ResetQuery bool `json:"resetQuery,omitempty"`
}

type PickModal struct {
	T       string    `json:"t"`
	Message string    `json:"message"`
	Rows    []PickRow `json:"rows"`
}

// Value is *string, not string: the TS side's "string | null" is a required
// field that can carry null (no selection, or a dismiss), so it must stay on
// the wire unconditionally -- never omitempty -- while still telling null
// apart from "".

type PickEvent struct {
	T      string  `json:"t"`
	Action string  `json:"action"`
	Value  *string `json:"value"`
	Query  string  `json:"query"`
}

type PickModalResult struct {
	T     string  `json:"t"`
	Value *string `json:"value"`
}

type PickResult struct {
	T      string   `json:"t"`
	Action string   `json:"action"`
	Value  *string  `json:"value"`
	Values []string `json:"values,omitempty"`
	Query  string   `json:"query"`
}

// DecodePickLine returns the message kind (its "t") and the raw line for a
// second, typed decode by the caller -- mirrors DecodeSessionLine, not the
// single-union DecodePrompt: pick has six message shapes, not one.
func DecodePickLine(line []byte) (string, []byte, error) {
	var probe struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrBadSpec, err)
	}
	if probe.T == "" {
		return "", nil, fmt.Errorf("%w: pick line without t", ErrBadSpec)
	}
	return probe.T, line, nil
}

// EncodePickResult mirrors EncodeIntent/EncodeClosed: T is stamped here, not
// by the caller, so a Model can build a PickResult without knowing the wire
// discriminator.
func EncodePickResult(r PickResult) []byte {
	r.T = "result"
	b, _ := json.Marshal(r)
	return append(b, '\n')
}

// EncodePickEvent mirrors EncodePickResult for the mid-session line an
// event:true action writes while the picker stays open.
func EncodePickEvent(e PickEvent) []byte {
	e.T = "event"
	b, _ := json.Marshal(e)
	return append(b, '\n')
}
