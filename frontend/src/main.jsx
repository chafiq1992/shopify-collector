import React, { Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { loadAuth, saveAuth } from './lib/auth'
import { readCurrentStore } from './lib/stores'
import AgentPagePicker, { AGENT_HOME, hasStaffPagePicker, staffPagePaths } from './components/AgentPagePicker'

const CollectorPage = lazy(() => import('./App'))
const LoginPage = lazy(() => import('./pages/Login'))
const AdminAnalyticsPage = lazy(() => import('./pages/AdminAnalytics'))
const InvoicesVerifierPage = lazy(() => import('./pages/InvoicesVerifier'))
const MyAnalyticsPage = lazy(() => import('./pages/MyAnalytics'))
const OrderBrowserPage = lazy(() => import('./pages/OrderBrowser'))
const OrderLookupPage = lazy(() => import('./pages/OrderLookup'))
const OrderTaggerPage = lazy(() => import('./pages/OrderTagger'))
const ShopifyConnectPage = lazy(() => import('./pages/ShopifyConnect'))
const VariantOrdersPage = lazy(() => import('./pages/VariantOrders'))
const ReturnScannerPage = lazy(() => import('./pages/ReturnScanner'))
const ConfirmationPage = lazy(() => import('./pages/Confirmation'))
const InventoryHelperPage = lazy(() => import('./pages/InventoryHelper'))

function PageFallback() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center text-gray-600">
      Loading...
    </div>
  )
}

function RouteShell() {
  const [auth, setAuth] = useState(() => loadAuth())
  const [store, setStore] = useState(() => readCurrentStore())
  const [, setRouteTick] = useState(0)
  const [lookupOpened, setLookupOpened] = useState(false)

  useEffect(() => {
    const rerender = () => {
      setAuth(loadAuth())
      setStore(readCurrentStore())
      setRouteTick((tick) => tick + 1)
    }
    try { window.addEventListener('popstate', rerender) } catch {}
    try { window.addEventListener('orderCollectorAuthCleared', rerender) } catch {}
    return () => {
      try { window.removeEventListener('popstate', rerender) } catch {}
      try { window.removeEventListener('orderCollectorAuthCleared', rerender) } catch {}
    }
  }, [])

  function handleLoginSuccess(data) {
    saveAuth(data)
    setAuth(data)
    try {
      const role = data?.user?.role
      if (hasStaffPagePicker(role)) {
        history.replaceState(null, '', `${AGENT_HOME}?store=${encodeURIComponent(readCurrentStore())}`)
      } else if (location.pathname === '/login') {
        history.replaceState(null, '', '/')
      }
    } catch {}
    setRouteTick((tick) => tick + 1)
  }

  const currentPath = (typeof location !== 'undefined' ? String(location.pathname || '').trim() : '/') || '/'
  const isAuthed = !!auth?.access_token
  const userRole = auth?.user?.role

  const hasPages = isAuthed && hasStaffPagePicker(userRole)
  const staffLookupActive = hasPages && currentPath === '/order-lookup'
  const redirectStaff = hasPages && !staffPagePaths(userRole).includes(currentPath)

  useEffect(() => {
    if (redirectStaff) {
      try {
        history.replaceState(null, '', `${AGENT_HOME}?store=${encodeURIComponent(readCurrentStore())}`)
        window.dispatchEvent(new PopStateEvent('popstate'))
      } catch {}
    }
  }, [redirectStaff])

  useEffect(() => {
    if (!hasPages) setLookupOpened(false)
    else if (staffLookupActive) setLookupOpened(true)
  }, [hasPages, staffLookupActive])

  let Page = CollectorPage
  let pageProps = {}

  if (!isAuthed && currentPath !== '/login') {
    Page = LoginPage
    pageProps = { onSuccess: handleLoginSuccess }
  } else if (hasPages && (redirectStaff || currentPath === AGENT_HOME)) {
    Page = AgentPagePicker
    pageProps = { role: userRole }
  } else {
    switch (currentPath) {
      case '/login':
        Page = isAuthed ? CollectorPage : LoginPage
        pageProps = isAuthed ? {} : { onSuccess: handleLoginSuccess }
        break
      case '/admin':
        Page = AdminAnalyticsPage
        break
      case '/invoices-verifier':
        Page = InvoicesVerifierPage
        break
      case '/my-analytics':
        Page = MyAnalyticsPage
        break
      case '/order-browser':
        Page = OrderBrowserPage
        break
      case '/order-lookup':
        Page = OrderLookupPage
        break
      case '/order-tagger':
        Page = OrderTaggerPage
        break
      case '/shopify-connect':
        Page = ShopifyConnectPage
        pageProps = { store, setStore }
        break
      case '/variant-orders':
        Page = VariantOrdersPage
        break
      case '/return-scanner':
        Page = ReturnScannerPage
        break
      case '/confirmation':
        Page = ConfirmationPage
        break
      case '/inventory-helper':
        Page = InventoryHelperPage
        break
      case '/verification':
        pageProps = { key: 'verification', verificationOnly: true }
        break
      case '/':
      default:
        Page = CollectorPage
        break
    }
  }

  return (
    <>
      {/* Keep pending fulfillment and print jobs active while staff switch pages. */}
      {hasPages && (staffLookupActive || lookupOpened) && (
        <div hidden={!staffLookupActive}>
          <Suspense fallback={<PageFallback />}>
            <OrderLookupPage showPages active={staffLookupActive} />
          </Suspense>
        </div>
      )}
      {!staffLookupActive && (
        <Suspense fallback={<PageFallback />}>
          <Page {...pageProps} />
        </Suspense>
      )}
    </>
  )
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, retryKey: 0 };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught error:', error, info);
    const message = String(error?.message || error || '');
    const isStaleAsset = /dynamically imported module|chunkloaderror|loading chunk|module script/i.test(message);
    if (isStaleAsset) {
      try {
        const key = `orderCollectorAssetReload:${location.pathname}`;
        const lastReload = Number(sessionStorage.getItem(key) || 0);
        if (!lastReload || Date.now() - lastReload > 30000) {
          sessionStorage.setItem(key, String(Date.now()));
          window.location.reload();
        }
      } catch {}
    }
  }
  retry = () => {
    this.setState((state) => ({ hasError: false, error: null, retryKey: state.retryKey + 1 }));
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#f9fafb', fontFamily: 'Inter, system-ui, sans-serif',
        }}>
          <div style={{
            maxWidth: 420, width: '100%', margin: '0 16px', padding: 32, borderRadius: 20,
            background: '#fff', boxShadow: '0 4px 24px rgba(0,0,0,0.08)', textAlign: 'center',
          }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111', margin: '0 0 8px' }}>
              Something went wrong
            </h2>
            <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 20px', lineHeight: 1.5 }}>
              The app ran into an unexpected error. This usually fixes itself with a reload.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
              <button
                onClick={this.retry}
                style={{
                  padding: '10px 22px', borderRadius: 12, border: '1px solid #d1d5db', cursor: 'pointer',
                  background: '#fff', color: '#374151', fontSize: 14, fontWeight: 600,
                }}
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '10px 22px', borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600,
                }}
              >
                Reload Page
              </button>
            </div>
            <details style={{ marginTop: 16, textAlign: 'left', fontSize: 11, color: '#9ca3af' }}>
              <summary style={{ cursor: 'pointer' }}>Error details</summary>
              <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {String(this.state.error)}
              </pre>
            </details>
          </div>
        </div>
      );
    }
    return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RouteShell />
    </ErrorBoundary>
  </React.StrictMode>
)
