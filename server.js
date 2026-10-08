require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const Razorpay = require('razorpay');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

function signToken(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' }); }
function setAuthCookie(res, payload) {
  res.cookie('veyra_token', signToken(payload), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*60*60*1000 });
}
function auth(req, res, next) {
  try {
    const token = req.cookies.veyra_token;
    if (!token) return res.status(401).json({ error: 'Please login first.' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Session expired. Please login again.' }); }
}
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate','Basic').json({ error:'Admin login required.' });
  const decoded = Buffer.from(h.slice(6), 'base64').toString();
  const i = decoded.indexOf(':');
  const user = decoded.slice(0,i), pass = decoded.slice(i+1);
  if (user !== (process.env.ADMIN_USER || 'admin') || pass !== (process.env.ADMIN_PASSWORD || 'change-this-password')) return res.status(401).json({ error:'Invalid admin credentials.' });
  next();
}
function makeOrderNumber() { return 'VEY-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(); }
function cleanEmail(v) { return String(v || '').trim().toLowerCase(); }
function rupees(paise) { return Math.round(paise) / 100; }

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req,res) => {
  try {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(400).send('Webhook secret not configured');
    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(req.body).digest('hex');
    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(400).send('Invalid signature');
    const event = JSON.parse(req.body.toString('utf8'));
    const payment = event.payload?.payment?.entity;
    if (payment?.order_id && payment?.id) {
      await pool.query('UPDATE orders SET payment_status=$1, razorpay_payment_id=$2 WHERE razorpay_order_id=$3', ['paid', payment.id, payment.order_id]);
    }
    res.json({ ok:true });
  } catch (e) { console.error(e); res.status(500).send('Webhook error'); }
});

app.use(express.json({ limit:'1mb' }));
app.use(cookieParser());

app.get('/api/health', async (_req,res) => { try { await pool.query('SELECT 1'); res.json({ok:true}); } catch { res.status(500).json({ok:false}); } });

app.get('/api/products', async (_req,res) => {
  try { const { rows } = await pool.query('SELECT id,name,price_paise,category,tag,image_url,description,stock FROM products WHERE active=true ORDER BY id DESC'); res.json(rows); }
  catch(e){ res.status(500).json({error:'Could not load products.'}); }
});

app.post('/api/auth/signup', async (req,res) => {
  try {
    const name=String(req.body.name||'').trim(), email=cleanEmail(req.body.email), password=String(req.body.password||'');
    if(name.length<2 || !email.includes('@') || password.length<6) return res.status(400).json({error:'Enter a valid name, email and password (6+ characters).'});
    const hash=await bcrypt.hash(password,12);
    const {rows} = await pool.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email',[name,email,hash]);
    setAuthCookie(res,{type:'user',id:rows[0].id,name:rows[0].name,email:rows[0].email});
    res.json({user:rows[0]});
  } catch(e){ if(e.code==='23505') return res.status(409).json({error:'Email is already registered.'}); res.status(500).json({error:'Signup failed.'}); }
});

app.post('/api/auth/login', async (req,res) => {
  try {
    const email=cleanEmail(req.body.email), password=String(req.body.password||'');
    const {rows}=await pool.query('SELECT id,name,email,password_hash FROM users WHERE email=$1',[email]);
    if(!rows[0] || !(await bcrypt.compare(password,rows[0].password_hash))) return res.status(401).json({error:'Wrong email or password.'});
    setAuthCookie(res,{type:'user',id:rows[0].id,name:rows[0].name,email:rows[0].email});
    res.json({user:{id:rows[0].id,name:rows[0].name,email:rows[0].email}});
  } catch { res.status(500).json({error:'Login failed.'}); }
});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('veyra_token');res.json({ok:true});});
app.get('/api/auth/me',(req,res)=>{try{const t=req.cookies.veyra_token;if(!t)return res.json({user:null});const u=jwt.verify(t,JWT_SECRET);res.json({user:{id:u.id,name:u.name,email:u.email}});}catch{res.json({user:null});}});

async function createOrder(req,res, online=false) {
  const client=await pool.connect();
  try {
    const {items,customer,payment_method='cod'}=req.body;
    if(!Array.isArray(items)||!items.length) return res.status(400).json({error:'Cart is empty.'});
    if(!customer?.name||!customer?.email||!customer?.phone||!customer?.address) return res.status(400).json({error:'Complete your delivery details.'});
    const ids=items.map(x=>Number(x.product_id)).filter(Number.isInteger);
    if(!ids.length) return res.status(400).json({error:'Invalid cart.'});
    await client.query('BEGIN');
    const {rows: products}=await client.query('SELECT * FROM products WHERE id=ANY($1::int[]) AND active=true FOR UPDATE',[ids]);
    const map=new Map(products.map(p=>[p.id,p])); let total=0; const normalized=[];
    for(const item of items){const p=map.get(Number(item.product_id)); const q=Math.max(1,Math.min(20,Number(item.quantity)||1)); if(!p) throw new Error('A product is no longer available.'); if(p.stock<q) throw new Error(`${p.name} is out of stock.`); total += p.price_paise*q; normalized.push({p,q});}
    const orderNo=makeOrderNumber();
    const r=await client.query(`INSERT INTO orders(order_number,user_id,customer_name,customer_email,phone,address,amount_paise,payment_method,payment_status,order_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,order_number,amount_paise`,[orderNo,req.user.id,customer.name.trim(),cleanEmail(customer.email),String(customer.phone).trim(),customer.address.trim(),total,payment_method,online?'pending':'pending','placed']);
    for(const {p,q} of normalized){await client.query('INSERT INTO order_items(order_id,product_id,product_name,price_paise,quantity) VALUES($1,$2,$3,$4,$5)',[r.rows[0].id,p.id,p.name,p.price_paise,q]);await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[q,p.id]);}
    await client.query('COMMIT');
    return res.json({order:r.rows[0]});
  } catch(e){await client.query('ROLLBACK');return res.status(400).json({error:e.message||'Could not create order.'});} finally{client.release();}
}

app.post('/api/orders',auth,(req,res)=>createOrder(req,res,false));
app.get('/api/my-orders',auth,async(req,res)=>{try{const {rows}=await pool.query('SELECT id,order_number,amount_paise,payment_method,payment_status,order_status,created_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]);res.json(rows);}catch{res.status(500).json({error:'Could not load orders.'});}});

app.post('/api/payments/create-order',auth,async(req,res)=>{
  if(!razorpay) return res.status(503).json({error:'Online payment is not configured yet.'});
  try {
    const {items,customer}=req.body;
    const fakeReq={...req,body:{items,customer,payment_method:'online'}};
    // Create a local order first so stock is reserved.
    const result=await new Promise(resolve=>createOrder(fakeReq,{status(c){return {json:x=>resolve({code:c,data:x})}},json:x=>resolve({code:200,data:x})},true));
    if(result.code>=400) return res.status(result.code).json(result.data);
    const local=result.data.order;
    const rp=await razorpay.orders.create({amount:local.amount_paise,currency:'INR',receipt:local.order_number});
    await pool.query('UPDATE orders SET razorpay_order_id=$1 WHERE id=$2',[rp.id,local.id]);
    res.json({key_id:process.env.RAZORPAY_KEY_ID,razorpay_order_id:rp.id,amount:rp.amount,currency:rp.currency,order_number:local.order_number});
  } catch(e){res.status(500).json({error:e.error?.description||e.message||'Payment setup failed.'});}
});

app.post('/api/payments/verify',auth,async(req,res)=>{
  try {
    const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body;
    const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id+'|'+razorpay_payment_id).digest('hex');
    if(!razorpay_signature || !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(razorpay_signature))) return res.status(400).json({error:'Payment verification failed.'});
    const {rows}=await pool.query('UPDATE orders SET payment_status=$1,razorpay_payment_id=$2 WHERE razorpay_order_id=$3 AND user_id=$4 RETURNING order_number',['paid',razorpay_payment_id,razorpay_order_id,req.user.id]);
    if(!rows[0]) return res.status(404).json({error:'Order not found.'});
    res.json({ok:true,order_number:rows[0].order_number});
  } catch(e){res.status(500).json({error:'Could not verify payment.'});}
});

app.get('/api/admin/orders',adminAuth,async(_req,res)=>{try{const {rows}=await pool.query('SELECT * FROM orders ORDER BY created_at DESC');res.json(rows);}catch{res.status(500).json({error:'Could not load orders.'});}});
app.patch('/api/admin/orders/:id',adminAuth,async(req,res)=>{try{const allowed=['placed','confirmed','shipped','delivered','cancelled'];if(!allowed.includes(req.body.status))return res.status(400).json({error:'Invalid status.'});const {rows}=await pool.query('UPDATE orders SET order_status=$1 WHERE id=$2 RETURNING id,order_number,order_status',[req.body.status,req.params.id]);res.json(rows[0]||{});}catch{res.status(500).json({error:'Update failed.'});}});
app.post('/api/admin/products',adminAuth,async(req,res)=>{try{const {name,price,category,tag,image_url,description,stock}=req.body;const {rows}=await pool.query('INSERT INTO products(name,price_paise,category,tag,image_url,description,stock) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[name,Math.round(Number(price)*100),category,tag||'',image_url||'',description||'',Math.max(0,Number(stock)||0)]);res.json(rows[0]);}catch{res.status(400).json({error:'Could not add product.'});}});
app.patch('/api/admin/products/:id',adminAuth,async(req,res)=>{try{const {name,price,category,tag,image_url,description,stock,active}=req.body;const {rows}=await pool.query('UPDATE products SET name=$1,price_paise=$2,category=$3,tag=$4,image_url=$5,description=$6,stock=$7,active=$8 WHERE id=$9 RETURNING *',[name,Math.round(Number(price)*100),category,tag||'',image_url||'',description||'',Math.max(0,Number(stock)||0),active!==false,req.params.id]);res.json(rows[0]||{});}catch{res.status(400).json({error:'Could not update product.'});}});
app.delete('/api/admin/products/:id',adminAuth,async(req,res)=>{try{await pool.query('UPDATE products SET active=false WHERE id=$1',[req.params.id]);res.json({ok:true});}catch{res.status(500).json({error:'Delete failed.'});}});

app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

async function init(){
  if(!process.env.DATABASE_URL){console.error('DATABASE_URL is missing.');process.exit(1);}
  const sql=fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8');
  await pool.query(sql);
  app.listen(PORT,()=>console.log(`VEYRA running on port ${PORT}`));
}
init().catch(e=>{console.error(e);process.exit(1);});
