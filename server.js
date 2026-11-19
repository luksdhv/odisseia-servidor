import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT=Number(process.env.PORT||3000);
const ORIGINS=(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_ROOMS=80,MAX_PEOPLE=8;
const rooms=new Map(), clients=new Map();
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const numeric=(n,a,b,otherwise=0)=>typeof n==='number'&&Number.isFinite(n)?clamp(n,a,b):otherwise;
const text=(s,max=30)=>typeof s==='string'?s.trim().replace(/[<>\x00-\x1f]/g,'').slice(0,max):'';
const uid=()=>crypto.randomBytes(9).toString('hex');
const hash=(password,salt)=>crypto.scryptSync(password,salt,32).toString('hex');
function send(ws,data){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));}
const publicRooms=()=>[...rooms.values()].map(r=>({id:r.id,name:r.name,players:r.members.size,maxPlayers:MAX_PEOPLE,hasPassword:true}));
function broadcast(room,data){for(const m of room.members.values())send(m.ws,data);}
function state(room){return {type:'snapshot',ship:room.ship,systems:room.systems,damages:room.damages,players:[...room.members.values()].map(m=>({id:m.id,name:m.name,area:m.area,pos:m.pos,yaw:m.yaw,mode:m.mode})),pilot:room.pilot};}
const center={bridge:[-6.65,.43,4.1],engineering:[5.4,.43,1.25]};
function damage(room,amount){if(room.systems.hull<=0)return;
 const blocked=room.systems.energy>0?amount*(room.systems.shield/100)*.9:0;
 room.systems.hull=clamp(room.systems.hull-(amount-blocked),0,100);
 room.systems.energy=clamp(room.systems.energy-blocked*.08,0,100);
 if(!room.damages.length || room.damages.every(d=>d.level<90)){
  const area=(room.hitCount++%2===0)?'bridge':'engineering';
  const existing=room.damages.find(d=>d.area===area);
  if(existing)existing.level=clamp(existing.level+25,0,100);
  else room.damages.push({id:uid(),area,level:25,pos:center[area]});
 }
}
function safePlayerPosition(area,pos){if(!Array.isArray(pos)||pos.length!==3)return null;
 const [x,,z]=pos;if(typeof x!=='number'||typeof z!=='number'||!Number.isFinite(x)||!Number.isFinite(z))return null;
 return area==='bridge'?[clamp(x,-8.6,8.6),.43,clamp(z,-8.6,8.6)]:[clamp(x,-7.3,7.3),.43,clamp(z,-8.2,8.2)];}
const server=http.createServer((req,res)=>{
 if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({ok:true,rooms:rooms.size}));return;}
 res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('Odisseia Estelar — multiplayer. Use WebSocket wss:// neste endereço.');
});
const wss=new WebSocketServer({server,maxPayload:8192,verifyClient(info,done){
 const origin=info.origin||'';done(ORIGINS.length===0||ORIGINS.includes(origin));
}});
function leave(ws){const c=clients.get(ws);if(!c)return;
 const room=rooms.get(c.roomId);if(room){room.members.delete(c.id);if(room.pilot===c.id)room.pilot=null;
 if(room.members.size===0)rooms.delete(room.id);else broadcast(room,state(room));}
 clients.delete(ws);
}
function within(m,area,point,dist){return m.area===area&&Math.hypot(m.pos[0]-point[0],m.pos[2]-point[2])<=dist;}
function handle(ws,msg){if(!msg||typeof msg!=='object'||Array.isArray(msg))return;
 const type=msg.type;
 if(type==='list'){send(ws,{type:'rooms',rooms:publicRooms()});return;}
 if(type==='create' || type==='join'){
  if(clients.has(ws)){send(ws,{type:'error',message:'Você já entrou em uma sala.'});return;}
  // Throttle authentication attempts and room creation per connection.
  const now=Date.now();ws.roomAttempts=(ws.roomAttempts||[]).filter(t=>now-t<60000);
  if(ws.roomAttempts.length>=8){send(ws,{type:'error',message:'Muitas tentativas. Tente novamente em um minuto.'});return;}
  ws.roomAttempts.push(now);
  let room;
  if(type==='create'){
   if(rooms.size>=MAX_ROOMS){send(ws,{type:'error',message:'Limite de salas atingido.'});return;}
   const name=text(msg.room,36),password=typeof msg.password==='string'?msg.password:'';
   if(name.length<3 || password.length<4 || password.length>64){send(ws,{type:'error',message:'Nome mínimo de 3 caracteres e senha de 4 a 64 caracteres.'});return;}
   const salt=crypto.randomBytes(16).toString('hex');
   room={id:uid(),name,salt,passHash:hash(password,salt),members:new Map(),pilot:null,hitCount:0,damages:[],ship:{pos:[0,0,0],heading:0,pitch:0,speed:0},systems:{energy:100,capacity:100,shield:0,hull:100}};
   rooms.set(room.id,room);
  }else{
   room=rooms.get(text(msg.roomId,32));
   if(!room){send(ws,{type:'error',message:'Sala não encontrada ou encerrada.'});return;}
   const pass=typeof msg.password==='string'?msg.password:'';
   if(pass.length>64 || !crypto.timingSafeEqual(Buffer.from(hash(pass,room.salt),'hex'),Buffer.from(room.passHash,'hex'))){send(ws,{type:'error',message:'Senha incorreta.'});return;}
  }
  if(room.members.size>=MAX_PEOPLE){send(ws,{type:'error',message:'Sala lotada.'});return;}
  const id=uid(),member={id,ws,name:text(msg.name,22)||'Tripulante',pos:[0,.43,4.8],yaw:0,mode:'walk',area:'bridge',controls:{},lastMove:0};
  room.members.set(id,member);clients.set(ws,{roomId:room.id,id});
  send(ws,{type:'welcome',id,roomId:room.id,roomName:room.name,maxPlayers:MAX_PEOPLE});broadcast(room,state(room));return;
 }
 const c=clients.get(ws);if(!c)return;
 const room=rooms.get(c.roomId),m=room?.members.get(c.id);if(!room||!m)return;
 if(type==='move'){
  const area=msg.area==='engineering'?'engineering':'bridge';
  const position=safePlayerPosition(area,msg.pos);
  if(!position)return;
  const now=Date.now();if(now-m.lastMove<35)return;m.lastMove=now;
  // Positions are visual prototype data, not authoritative anti-cheat movement yet.
  m.pos=position;m.area=area;m.yaw=numeric(msg.yaw,-6.3,6.3);m.mode=['walk','pilot','shield','radar','captain','engineer'].includes(msg.mode)?msg.mode:'walk';
  if(m.mode!=='pilot'&&room.pilot===m.id)room.pilot=null;
 }else if(type==='pilot'){
  if(msg.active===true){if((!room.pilot||room.pilot===m.id)&&within(m,'bridge',[-2.304,.43,-2.376],3.5))room.pilot=m.id;
   else send(ws,{type:'error',message:'Posto do piloto ocupado ou distante.'});}
  else if(room.pilot===m.id)room.pilot=null;
 }else if(type==='flight'){
  if(room.pilot!==m.id)return;
  const input=msg.controls||{};m.controls={w:input.w===true,s:input.s===true,a:input.a===true,d:input.d===true,q:input.q===true,e:input.e===true,brake:input.brake===true,boost:input.boost===true};
 }else if(type==='shield'){
  if(m.mode==='shield'&&within(m,'bridge',[-5.15,.43,1.9],3.5))room.systems.shield=numeric(msg.value,0,100,room.systems.shield);
 }else if(type==='charge'){
  m.charging=msg.active===true&&m.mode==='walk'&&within(m,'engineering',[2.15,.43,-1.55],2.5);
 }else if(type==='testHit'){
  if(m.mode==='shield'&&within(m,'bridge',[-5.15,.43,1.9],3.5)&&Date.now()-(m.lastTestHit||0)>800){m.lastTestHit=Date.now();damage(room,12);}
 }else if(type==='repair'){
  if(m.mode!=='walk')return;
  const d=room.damages.find(x=>x.id===msg.id);
  if(!d||!within(m,d.area,d.pos,2.3))return;
  const ms=Date.now();if(ms-(m.lastRepair||0)<700)return;m.lastRepair=ms;
  d.level=Math.max(0,d.level-10);
  room.systems.hull=Math.min(100,room.systems.hull+4);
  if(d.level<=0)room.damages=room.damages.filter(x=>x!==d);
 }else if(type==='reset'&&room.pilot===m.id){room.ship={pos:[0,0,0],heading:0,pitch:0,speed:0};}
}
wss.on('connection',ws=>{
 ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true;});
 ws.on('message',raw=>{try{const msg=JSON.parse(String(raw));handle(ws,msg);}catch{send(ws,{type:'error',message:'Mensagem inválida.'});}});
 ws.on('close',()=>leave(ws));ws.on('error',()=>leave(ws));send(ws,{type:'hello',version:'0.9'});
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30000);
wss.on('close',()=>clearInterval(heartbeat));
let tickTime=Date.now();
setInterval(()=>{
 const now=Date.now(),dt=Math.min(.1,(now-tickTime)/1000);tickTime=now;
 for(const r of rooms.values()){
  const s=r.systems,ship=r.ship;
  s.energy=Math.max(0,s.energy-(.025+.50*Math.pow(s.shield/100,2))*dt);
  if(s.energy===0)s.shield=0;
  for(const m of r.members.values())if(m.charging&&m.mode==='walk'&&within(m,'engineering',[2.15,.43,-1.55],2.5))s.energy=Math.min(100,s.energy+12*dt);
  if(r.pilot){const pilot=r.members.get(r.pilot),c=pilot?.controls||{};const boost=c.boost?1.9:1;
   if(c.w)ship.speed=Math.min(190,ship.speed+57*dt*boost);
   if(c.s)ship.speed=Math.max(-45,ship.speed-68*dt);
   if(c.brake)ship.speed*=Math.max(0,1-dt*2.8);
   if(c.a)ship.heading+=dt*(.5+Math.min(1,Math.abs(ship.speed)/100)*.45);
   if(c.d)ship.heading-=dt*(.5+Math.min(1,Math.abs(ship.speed)/100)*.45);
   if(c.q)ship.pitch=clamp(ship.pitch+dt*.5,-.8,.8);
   if(c.e)ship.pitch=clamp(ship.pitch-dt*.5,-.8,.8);
   ship.pos[0]-=Math.sin(ship.heading)*Math.cos(ship.pitch)*ship.speed*dt;
   ship.pos[1]+=Math.sin(ship.pitch)*ship.speed*dt;
   ship.pos[2]-=Math.cos(ship.heading)*Math.cos(ship.pitch)*ship.speed*dt;
   for(const target of [{pos:[0,0,-640],r:88,name:'Aurora'},{pos:[-330,10,-920],r:140,name:'Planeta azul'},{pos:[440,-75,-1550],r:100,name:'Planeta âmbar'},{pos:[-155,-65,-450],r:30,name:'Lua'}]){
    const v=ship.pos.map((n,i)=>n-target.pos[i]),dist=Math.hypot(...v),limit=target.r+22;
    if(dist>=limit)continue;
    const normal=v.map(n=>n/(dist||1));for(let i=0;i<3;i++)ship.pos[i]=target.pos[i]+normal[i]*(limit+.5);
    const speed=Math.abs(ship.speed);ship.speed=0;
    if(speed>1 && now-(r.lastCrash||0)>2200){damage(r,20);r.lastCrash=now;}
   }
  }
  broadcast(r,state(r));
 }
},100);
server.listen(PORT,'0.0.0.0',()=>console.log('Odisseia multiplayer ouvindo porta '+PORT));
