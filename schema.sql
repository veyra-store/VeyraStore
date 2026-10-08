CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  category VARCHAR(80) NOT NULL,
  tag VARCHAR(80),
  image_url TEXT,
  description TEXT,
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(40) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  address TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cod','online')),
  payment_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  order_status VARCHAR(30) NOT NULL DEFAULT 'placed',
  razorpay_order_id VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(160) NOT NULL,
  price_paise INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);

INSERT INTO products (name, price_paise, category, tag, image_url, description, stock)
SELECT 'Classic Oversized Tee', 89900, 'Clothing', 'NEW', 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=900&q=80', 'Soft everyday oversized t-shirt.', 25
WHERE NOT EXISTS (SELECT 1 FROM products);
