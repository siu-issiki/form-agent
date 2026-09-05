export const ADMIN_STYLES = `
:root {
	color-scheme: light;
	--ink: #183042;
	--muted: #667b8a;
	--surface: #fff;
	--canvas: #f2f6fa;
	--action: #2262d3;
	--success: #168365;
	--line: #dce5ed;
}
* {
	box-sizing: border-box;
}
body {
	margin: 0;
	color: var(--ink);
	background: var(--canvas);
	font:
		14px / 1.6 -apple-system,
		BlinkMacSystemFont,
		"Hiragino Sans",
		"Yu Gothic UI",
		sans-serif;
}
a {
	color: var(--action);
	text-decoration: none;
}
a:hover {
	text-decoration: underline;
}
button,
input,
select {
	font: inherit;
}
button,
a,
input,
select,
summary {
	outline-offset: 4px;
}
a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible {
	outline: 3px solid #91b5f7;
}
.skip {
	position: absolute;
	top: -100px;
	left: 10px;
	z-index: 10;
	background: white;
	padding: 12px;
}
.skip:focus {
	top: 10px;
}
.topbar {
	height: 72px;
	background: var(--surface);
	border-bottom: 1px solid var(--line);
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0 32px;
}
.brand {
	display: flex;
	align-items: center;
	gap: 12px;
	color: var(--ink);
	font:
		600 20px "Avenir Next",
		sans-serif;
	letter-spacing: -0.5px;
}
.mark {
	width: 30px;
	height: 30px;
	border-radius: 8px;
	background: var(--action);
	color: white;
	text-align: center;
	font-size: 21px;
	line-height: 30px;
}
.owner {
	font-size: 12px;
	color: var(--muted);
}
.workspace {
	display: grid;
	grid-template-columns: 190px minmax(0, 1fr);
	min-height: calc(100vh - 72px);
}
.sidebar {
	padding: 28px 16px;
	border-right: 1px solid var(--line);
	background: #f7f9fc;
}
.sidebar p {
	font-size: 11px;
	letter-spacing: 0.13em;
	color: var(--muted);
	margin: 0 12px 12px;
}
.navlink {
	display: block;
	padding: 12px 14px;
	border-radius: 8px;
	color: var(--muted);
	margin-bottom: 6px;
}
.navlink[aria-current="page"] {
	background: #e5edfc;
	color: var(--action);
	font-weight: 650;
}
.sidebar small {
	display: block;
	color: var(--muted);
	padding: 30px 12px;
}
.main {
	padding: 36px;
	max-width: 1510px;
	width: 100%;
	margin: auto;
}
.heading {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 20px;
	margin-bottom: 26px;
}
.eyebrow {
	font:
		600 11px "Avenir Next",
		sans-serif;
	letter-spacing: 0.16em;
	color: var(--muted);
	margin: 0 0 6px;
}
h1 {
	font-size: 26px;
	line-height: 1.4;
	margin: 0 0 6px;
	letter-spacing: -0.03em;
}
h2 {
	font-size: 17px;
	line-height: 1.5;
	margin: 0;
}
h3 {
	font-size: 14px;
	margin: 0;
}
.muted {
	color: var(--muted);
}
.heading p {
	margin: 4px 0 0;
}
.button,
button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border: 1px solid var(--line);
	border-radius: 7px;
	background: white;
	color: var(--ink);
	padding: 9px 14px;
	cursor: pointer;
	white-space: nowrap;
}
.primary {
	background: var(--action);
	color: white;
	border-color: var(--action);
}
.filters {
	background: white;
	border: 1px solid var(--line);
	border-radius: 12px;
	padding: 18px;
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: 12px;
	margin: 0 0 24px;
}
.filters label {
	display: grid;
	gap: 5px;
	font-size: 12px;
	color: var(--muted);
}
input,
select {
	min-height: 39px;
	background: white;
	border: 1px solid #c9d5e0;
	border-radius: 6px;
	padding: 7px 10px;
	color: var(--ink);
	max-width: 100%;
}
.filters .search {
	flex: 1;
	min-width: 150px;
}
.filters .campaign {
	width: 170px;
}
.cards {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: 16px;
	margin-bottom: 22px;
}
.card {
	background: white;
	border: 1px solid var(--line);
	border-radius: 12px;
	padding: 20px;
}
.card .label {
	font-size: 12px;
	color: var(--muted);
}
.metric {
	font-size: 32px;
	line-height: 1.5;
	font-weight: 620;
	letter-spacing: -0.04em;
	font-variant-numeric: tabular-nums;
}
.metric.green {
	color: var(--success);
}
.card small {
	color: var(--muted);
	font-size: 11px;
}
.panel {
	background: white;
	border: 1px solid var(--line);
	border-radius: 12px;
	overflow: hidden;
	margin-bottom: 22px;
}
.panel-title {
	padding: 20px 22px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
}
.panel-title p {
	font-size: 12px;
	color: var(--muted);
	margin: 3px 0 0;
}
.distribution {
	display: flex;
	flex-wrap: wrap;
	gap: 9px;
	padding: 0 22px 22px;
}
.distribution a {
	color: var(--ink);
	background: #f6f8fb;
	border: 1px solid var(--line);
	border-radius: 6px;
	padding: 7px 10px;
	font-size: 12px;
}
.distribution strong {
	margin-left: 12px;
	font-variant-numeric: tabular-nums;
}
.chart {
	display: flex;
	align-items: stretch;
	gap: 10px;
	height: 184px;
	min-width: 550px;
	padding: 8px 24px 0;
}
.day {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	min-width: 22px;
}
.bar-area {
	height: 130px;
	width: 100%;
	display: flex;
	align-items: flex-end;
	justify-content: center;
	gap: 3px;
	border-bottom: 1px solid var(--line);
}
.bar {
	width: 12px;
	border-radius: 3px 3px 0 0;
	max-width: 40%;
	min-height: 0;
}
.bar.registered {
	background: #b9cbea;
}
.bar.sent {
	background: var(--success);
}
.day-label {
	font-size: 11px;
	color: var(--muted);
	margin-top: 8px;
}
.legend {
	display: flex;
	gap: 18px;
	padding: 0 22px 10px;
	font-size: 12px;
	color: var(--muted);
}
.dot {
	width: 9px;
	height: 9px;
	border-radius: 2px;
	display: inline-block;
	margin-right: 6px;
}
.scroll {
	overflow-x: auto;
}
table {
	width: 100%;
	border-collapse: collapse;
	text-align: left;
}
th {
	font-size: 11px;
	font-weight: 500;
	letter-spacing: 0.03em;
	color: var(--muted);
	padding: 12px 22px;
	border-top: 1px solid var(--line);
	border-bottom: 1px solid var(--line);
	background: #fafbfd;
	white-space: nowrap;
}
td {
	padding: 16px 22px;
	border-bottom: 1px solid #eaf0f5;
	font-size: 13px;
	vertical-align: middle;
}
tbody tr:last-child td {
	border-bottom: 0;
}
tbody tr:hover {
	background: #f9fbfe;
}
td small {
	display: block;
	font-size: 11px;
	color: var(--muted);
	margin-top: 3px;
	max-width: 240px;
	overflow-wrap: anywhere;
}
.company {
	font-weight: 600;
	color: var(--ink);
	font-size: 14px;
}
.nowrap {
	white-space: nowrap;
}
.num {
	text-align: right;
	font-variant-numeric: tabular-nums;
}
.badge {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	border-radius: 5px;
	background: #edf2f6;
	color: #526779;
	padding: 4px 8px;
	font-size: 11px;
	font-weight: 550;
	white-space: nowrap;
}
.badge.sent {
	color: #08734f;
	background: #e6f5ed;
}
.badge.uncertain {
	color: #956009;
	background: #fff3d9;
}
.badge.failed,
.badge.dead_lettered {
	color: #ad4352;
	background: #fdeef0;
}
.badge.running,
.badge.submitting {
	color: #2262d3;
	background: #eaf0ff;
}
.badge.prohibited {
	color: #756480;
	background: #f0edf5;
}
.empty {
	text-align: center;
	padding: 50px 22px;
	color: var(--muted);
}
.empty strong {
	display: block;
	color: var(--ink);
	font-size: 16px;
	margin-bottom: 8px;
}
.pagination {
	padding: 15px 22px;
	border-top: 1px solid var(--line);
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 14px;
	font-size: 12px;
	color: var(--muted);
}
.pagination nav {
	display: flex;
	gap: 8px;
}
.note {
	font-size: 12px;
	color: var(--muted);
	margin: 0 0 14px;
}
.detail-grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 320px;
	gap: 22px;
}
.details {
	padding: 0 22px 22px;
}
.facts {
	display: grid;
	grid-template-columns: 100px minmax(0, 1fr);
	gap: 12px;
	margin: 0;
}
.facts dt {
	color: var(--muted);
	font-size: 12px;
}
.facts dd {
	margin: 0;
	overflow-wrap: anywhere;
}
.reason {
	background: #f5f8fc;
	border-left: 3px solid #b8ccec;
	padding: 14px 16px;
	margin: 18px 0 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.mono {
	font:
		12px / 1.6 ui-monospace,
		SFMono-Regular,
		monospace;
	overflow-wrap: anywhere;
}
.payload-row {
	padding: 15px 0;
	border-bottom: 1px solid var(--line);
}
.payload-row:last-child {
	border: 0;
}
.payload-row dt {
	font-size: 12px;
	color: var(--muted);
	margin-bottom: 6px;
}
.payload-row dd {
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.evidence-list {
	padding: 0 22px 22px;
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 16px;
}
.evidence {
	margin: 0;
	border: 1px solid var(--line);
	border-radius: 8px;
	overflow: hidden;
}
.evidence img {
	display: block;
	width: 100%;
	height: 260px;
	object-fit: contain;
	object-position: top;
	background: #f5f7fa;
}
.evidence figcaption {
	padding: 12px;
}
.evidence small {
	display: block;
	font-size: 11px;
	color: var(--muted);
	margin-top: 4px;
}
.json-evidence {
	padding: 40px 16px;
	background: #f3f7fc;
	text-align: center;
	display: block;
}
.alert {
	border-left: 3px solid #d29730;
	background: #fffaee;
	padding: 13px 16px;
	margin: 0 22px 16px;
	font-size: 12px;
	overflow-wrap: anywhere;
}
details.daily-table {
	padding: 0 22px 18px;
}
summary {
	cursor: pointer;
	color: var(--action);
	font-size: 12px;
}
.daily-table table {
	margin-top: 12px;
}
.footer {
	font-size: 11px;
	color: var(--muted);
	text-align: right;
	padding-top: 2px;
}
.error {
	max-width: 620px;
	margin: 60px auto;
	padding: 32px;
}
.error p {
	white-space: pre-wrap;
}
.back {
	display: inline-block;
	margin-bottom: 18px;
}
.value {
	font-variant-numeric: tabular-nums;
}
@media (min-width: 1600px) {
	.main {
		padding: 44px;
	}
}
@media (max-width: 1100px) {
	.workspace {
		grid-template-columns: 150px minmax(0, 1fr);
	}
	.main {
		padding: 24px;
	}
	.cards {
		gap: 10px;
	}
	.card {
		padding: 15px;
	}
	.detail-grid {
		grid-template-columns: 1fr;
	}
	.details-side {
		order: -1;
	}
	.metric {
		font-size: 28px;
	}
}
@media (max-width: 760px) {
	.topbar {
		height: 62px;
		padding: 0 18px;
	}
	.owner {
		font-size: 10px;
	}
	.workspace {
		display: block;
	}
	.sidebar {
		display: flex;
		padding: 10px 16px;
		gap: 8px;
		border-right: 0;
		border-bottom: 1px solid var(--line);
	}
	.sidebar p,
	.sidebar small {
		display: none;
	}
	.navlink {
		padding: 8px 14px;
		margin: 0;
	}
	.main {
		padding: 22px 16px;
	}
	.heading {
		gap: 10px;
	}
	h1 {
		font-size: 23px;
	}
	.heading .button {
		padding: 7px 10px;
		font-size: 12px;
	}
	.cards {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}
	.filters {
		padding: 14px;
		gap: 10px;
	}
	.filters label {
		flex: 1;
		min-width: 125px;
	}
	.filters .campaign {
		width: auto;
	}
	.panel-title {
		padding: 16px;
	}
	.evidence-list {
		grid-template-columns: 1fr;
		padding: 0 16px 16px;
	}
	th,
	td {
		padding: 12px 16px;
	}
	.pagination {
		flex-wrap: wrap;
	}
	.metric {
		font-size: 29px;
	}
	.footer {
		text-align: left;
	}
}
`;
