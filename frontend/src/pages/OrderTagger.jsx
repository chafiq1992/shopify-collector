import React, { useEffect, useState } from "react";

export default function OrderTagger(){
	const [status, setStatus] = useState({ ok: true, enabled: false, zones: [] });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);

	useEffect(() => {
		let alive = true;
		(async () => {
			try {
				setLoading(true);
				const r = await fetch("/api/order-tagger/status");
				const js = await r.json();
				if (!alive) return;
				setStatus(js);
			} catch (e) {
				if (!alive) return;
				setError("Failed to load status");
			} finally {
				if (alive) setLoading(false);
			}
		})();
		return () => { alive = false; };
	}, []);

	return (
		<div className="min-h-screen w-full bg-gray-50 text-gray-900">
			<header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-gray-200">
				<div className="max-w-4xl mx-auto px-4 py-3">
					<h1 className="text-xl font-semibold">Order Tagger</h1>
					<p className="text-sm text-gray-600">Auto-tag Shopify orders by delivery zone</p>
				</div>
			</header>
			<main className="max-w-4xl mx-auto px-4 py-6">
				{loading ? (
					<div className="text-gray-600">Loading…</div>
				) : error ? (
					<div className="text-red-600">{error}</div>
				) : (
					<>
						<section className="mb-6">
							<div className="rounded-xl border border-gray-200 bg-white p-4">
								<div className="flex items-center justify-between">
									<div>
										<div className="text-sm text-gray-500">Feature flag</div>
										<div className="text-lg font-semibold">{status.enabled ? "Enabled" : "Disabled"}</div>
									</div>
									<div className={`px-3 py-1 rounded-full text-sm font-medium ${status.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
										{status.enabled ? "ACTIVE" : "INACTIVE"}
									</div>
								</div>
							</div>
						</section>
						<section className="mb-6">
							<div className="rounded-xl border border-gray-200 bg-white p-4">
								<h2 className="text-base font-semibold mb-3">Zones</h2>
								{(status.zones || []).length === 0 ? (
									<div className="text-sm text-gray-600">No zones loaded.</div>
								) : (
									<ul className="text-sm">
										{status.zones.map((z, i) => (
											<li key={i} className="flex items-center justify-between py-2 border-b last:border-b-0">
												<div>
													<div className="font-medium">{z.name || "Untitled zone"}</div>
													<div className="text-gray-500">Geometry: {z.geometryType}</div>
												</div>
												<div className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 text-xs font-semibold">{z.tag}</div>
											</li>
										))}
									</ul>
								)}
							</div>
						</section>
						<section>
							<div className="rounded-xl border border-gray-200 bg-white p-4">
								<h2 className="text-base font-semibold mb-2">How to add new zones</h2>
								<ol className="list-decimal ml-6 text-sm text-gray-700 space-y-1">
									<li>Edit <code>backend/app/zones.geojson</code> and add new Feature(s) with <code>properties.tag</code>.</li>
									<li>Deploy the backend. No code changes needed.</li>
									<li>Optionally set <code>AUTO_TAGGING_ENABLED=1</code> to activate tagging.</li>
								</ol>
							</div>
						</section>
					</>
				)}
			</main>
		</div>
	);
}


