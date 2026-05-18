import React, { Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { loadAuth, saveAuth } from './lib/auth'
import { readCurrentStore } from './lib/stores'

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
      const isAgent = role === 'agent'
      if (String(location.pathname || '') === '/login') {
        history.replaceState(null, '', isAgent ? '/confirmation' : '/')
      } else if (isAgent && String(location.pathname || '') === '/') {
        history.replaceState(null, '', '/confirmation')
      }
    } catch {}
    setRouteTick((tick) => tick + 1)
  }

  const currentPath = (typeof location !== 'undefined' ? String(location.pathname || '').trim() : '/') || '/'
  const isAuthed = !!auth?.access_token
  const userRole = auth?.user?.role

  // Agents are scoped to the confirmation page; redirect away from anything else (except /login).
  useEffect(() => {
    if (isAuthed && userRole === 'agent' && currentPath !== '/confirmation' && currentPath !== '/login') {
      try {
        history.replaceState(null, '', '/confirmation')
        window.dispatchEvent(new PopStateEvent('popstate'))
      } catch {}
    }
  }, [isAuthed, userRole, currentPath])

  let Page = CollectorPage
  let pageProps = {}

  if (!isAuthed && currentPath !== '/login') {
    Page = LoginPage
    pageProps = { onSuccess: handleLoginSuccess }
  } else if (isAuthed && userRole === 'agent' && currentPath !== '/confirmation') {
    Page = ConfirmationPage
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
      case '/':
      default:
        Page = CollectorPage
        break
    }
  }

  return (
    <Suspense fallback={<PageFallback />}>
      <Page {...pageProps} />
    </Suspense>
  )
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught error:', error, info);
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
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 28px', borderRadius: 12, border: 'none', cursor: 'pointer',
                background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600,
              }}
            >
              Reload Page
            </button>
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
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RouteShell />
    </ErrorBoundary>
  </React.StrictMode>
)
