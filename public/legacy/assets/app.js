const $=id=>document.getElementById(id);
const S={ticks:[],secs:[],lastSec:0,price:null,ws:0,s0:null,mkt:null,askUp:null,askDown:null,
  running:false,bank:100,bank0:100,trades:0,wins:0,open:null,halted:false,tokenKey:''};
function log(m){const d=$('log');d.insertAdjacentHTML('afterbegin','<div>'+new Date().toLocaleTimeString()+'  '+m+'</div>');while(d.children.length>80)d.lastChild.remove();}
function Phi(x){const t=1/(1+0.2316419*Math.abs(x)),d=0.3989423*Math.exp(-x*x/2);
  const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function sigma(){const a=S.secs.slice(-90);if(a.length<20)return 0.0001;
  const r=[];for(let i=1;i<a.length;i++)r.push(Math.log(a[i]/a[i-1]));
  const m=r.reduce((x,y)=>x+y,0)/r.length;const v=r.reduce((x,y)=>x+(y-m)**2,0)/r.length;
  return Math.max(Math.sqrt(v),0.00003);}
function fairUp(price,T){return Phi(Math.log(price/S.s0)/(sigma()*Math.sqrt(Math.max(T,1))));}
const money=n=>'$'+n.toFixed(2);

// ---- Binance live BTC price ----
function connect(){
  const w=new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
  w.onmessage=e=>{const p=parseFloat(JSON.parse(e.data).p),now=Date.now();
    S.price=p;S.ticks.push({t:now,p});while(S.ticks.length&&S.ticks[0].t<now-15000)S.ticks.shift();
    if(now-S.lastSec>=1000){S.lastSec=now;S.secs.push(p);if(S.secs.length>300)S.secs.shift();}};
  w.onclose=()=>{log('Price feed closed, reconnecting');setTimeout(connect,2000);};
  w.onerror=()=>w.close();
}
function lagged(ms){const c=Date.now()-ms;let r=null;for(const k of S.ticks){if(k.t<=c)r=k.p;else break;}return r;}

// ---- Polymarket market lookup + order book ----
const G=location.protocol==='file:'?'https://gamma-api.polymarket.com':'/gamma';
const C=location.protocol==='file:'?'https://clob.polymarket.com':'/clob';
async function loadMarket(ws){
  S.mkt=null;S.askUp=S.askDown=null;
  try{
    const r=await fetch(G+'/markets?slug=btc-updown-5m-'+ws);
    const j=await r.json();if(!j.length)throw new Error('market not found');
    const ids=JSON.parse(j[0].clobTokenIds),outs=JSON.parse(j[0].outcomes);
    const iu=outs.findIndex(o=>/up/i.test(o));
    S.mkt={up:ids[iu],down:ids[1-iu]};log('Loaded market for window '+new Date(ws*1000).toLocaleTimeString());
  }catch(e){log('Polymarket lookup failed: '+e.message+' (try Demo mode)');}
}
async function bestAsk(token){
  const r=await fetch(C+'/book?token_id='+token);const b=await r.json();
  const a=(b.asks||[]).map(x=>parseFloat(x.price));return a.length?Math.min(...a):null;
}
async function pollBook(){
  if(!S.running||$('mode').value!=='live'||!S.mkt)return;
  try{[S.askUp,S.askDown]=await Promise.all([bestAsk(S.mkt.up),bestAsk(S.mkt.down)]);}catch(e){log('Order book error: '+e.message);}
}

// ---- main loop ----
function tick(){
  const now=Date.now()/1000,ws=Math.floor(now/300)*300,T=ws+300-now;
  if(ws!==S.ws){
    if(S.open&&S.price)settle(S.price);
    S.ws=ws;S.s0=S.price;S.open=null;
    if(S.running&&$('mode').value==='live')loadMarket(ws);
  }
  const p=S.price;let fair=null,edgeBest=null,side=null,ask=null;
  if(p&&S.s0){
    fair=fairUp(p,T);
    if($('mode').value==='sim'){
      const lp=lagged(+$('lag').value);
      if(lp){const f=Phi(Math.log(lp/S.s0)/(sigma()*Math.sqrt(Math.max(T,1))));
        S.askUp=Math.min(0.99,Math.max(0.01,f+0.01));S.askDown=Math.min(0.99,Math.max(0.01,1-f+0.01));}
    }
    const fee=+$('fee').value/100;
    if(S.askUp&&S.askDown){
      const eu=fair-S.askUp-fee,ed=(1-fair)-S.askDown-fee;
      if(eu>=ed){edgeBest=eu;side='Up';ask=S.askUp;}else{edgeBest=ed;side='Down';ask=S.askDown;}
      if(S.running&&!S.halted&&!S.open&&T>+$('mint').value&&edgeBest>=+$('thr')/100&&ask>0.03&&ask<0.97)
        enter(side,ask,side==='Up'?fair:1-fair,ws);
    }
  }
  $('spot').textContent=p?money(p):'-';
  $('s0').textContent=S.s0?money(S.s0):'waiting for next window';
  $('tleft').textContent=Math.floor(T/60)+':'+String(Math.floor(T%60)).padStart(2,'0');
  $('fair').textContent=fair==null?'-':(fair*100).toFixed(1)+'%';
  $('ask').textContent=S.askUp&&S.askDown?S.askUp.toFixed(2)+' / '+S.askDown.toFixed(2):'-';
  const ee=$('edge');ee.textContent=edgeBest==null?'-':(edgeBest*100).toFixed(1)+'% '+side;ee.className='big '+(edgeBest>0?'up':'down');
  $('bank').textContent=money(S.bank);
  $('wl').textContent=S.wins+' / '+S.trades;
}
function enter(side,ask,fairSide,ws){
  const stake=S.bank*(+$('stake').value/100);if(stake<0.01)return;
  S.open={side,ask,fair:fairSide,stake,shares:stake/ask,ws,s0:S.s0};
  S.bank-=stake;
  log('BUY '+side+' at '+ask.toFixed(2)+' stake '+money(stake));
}
function settle(endPrice){
  const o=S.open;if(!o)return;
  const upWon=endPrice>=o.s0,won=(o.side==='Up')===upWon,payout=won?o.shares:0;
  S.bank+=payout;S.trades++;if(won)S.wins++;
  const pr=payout-o.stake;
  $('trades').insertAdjacentHTML('afterbegin','<tr><td>'+new Date(o.ws*1000).toLocaleTimeString()+'</td><td>'+o.side+'</td><td>'+o.ask.toFixed(2)+'</td><td>'+(o.fair*100).toFixed(0)+'%</td><td>'+money(o.stake)+'</td><td class="'+(won?'up':'down')+'">'+(won?'Win':'Loss')+'</td><td class="'+(pr>=0?'up':'down')+'">'+(pr>=0?'+':'')+money(pr)+'</td></tr>');
  log('SETTLED '+(won?'WIN':'LOSS')+' '+(pr>=0?'+':'')+money(pr));
  if(S.bank<S.bank0*(1-$('cap').value/100)){S.halted=true;log('Daily loss limit hit. Bot halted.');$('status').textContent='Halted: loss limit reached.';}
}
$('go').onclick=()=>{
  S.running=!S.running;
  if(S.running){S.bank0=+$('bank0').value;if(!S.trades&&!S.open)S.bank=S.bank0;S.halted=false;
    $('go').textContent='Stop bot';$('go').className='stop';$('status').textContent='Running. Trades start at the next 5-minute window.';
    if($('mode').value==='live'&&S.ws)loadMarket(S.ws);}
  else{$('go').textContent='Start bot';$('go').className='';$('status').textContent='Stopped.';}
};
$('reset').onclick=()=>{S.bank0=+$('bank0').value;S.bank=S.bank0;S.trades=S.wins=0;S.open=null;S.halted=false;$('trades').innerHTML='';log('Results reset');};
S.bank=S.bank0;connect();setInterval(tick,500);setInterval(pollBook,2000);
