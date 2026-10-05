'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.resolve(__dirname,'../../user-pwa/index.html'),'utf8');
test('previews expose only opening and accurate percentage with three states',()=>{
 const c={DPGoal:require('../../shared/goal-progress'),state:{logs:{},progress:{}},getProgress:()=>({amount:0}),escapeHtml:String,habitDisplayEmoji:()=> '✓'};vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('  function progressPercent'),html.indexOf('  function buildHabitCard')),c);
 vm.runInContext(html.slice(html.indexOf('  function buildHabitPreview'),html.indexOf('  function renderToday')),c);
 const h={id:'task',name:'Goal',type:'assignment',config:{target:1000}};
 for(const [amount,percent,cls] of [[0,0,'not-started'],[0.1,1,'in-progress'],[999,99,'in-progress'],[1000,100,'done']]){
  c.getProgress=()=>({amount});assert.equal(c.habitPercent(h,'2026-10-03'),percent);const markup=c.buildHabitPreview(h,'2026-10-03');assert.match(markup,new RegExp(cls));assert.match(markup,/data-action="open-habit-card"/);assert.doesNotMatch(markup,/data-action="(?:toggle|increment|edit|add-)/);
 }
 assert.doesNotMatch(c.buildHabitPreview({...h,assignedBy:5},'2026-10-03'),/data-habit-edit=/);
});
test('hold animates after one second, edits at three and cancels on movement/release',()=>{
 const listeners={},timers=new Map(),classes=new Set();let now=0,next=0,edits=0;
 const card={isConnected:true,getAttribute:()=> 'task',classList:{add:k=>classes.add(k),remove:k=>classes.delete(k)}};
 const target={closest:s=>s==='[data-habit-edit]'?card:null};
 const c={state:{habits:[{id:'task'}]},document:{addEventListener:(k,fn)=>listeners[k]=fn},window:{addEventListener(){}},setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),closeModal(){},habitModal(){edits++;},Date:{now:()=>now},Math};vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('  var cardEditGesture='),html.indexOf('  /* ---------- calendar long-press')),c);
 const advance=ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}};
 const down=()=>listeners.pointerdown({button:0,isPrimary:true,target,pointerId:1,clientX:0,clientY:0});
 down();advance(999);assert.equal(classes.size,0);advance(1);assert.ok(classes.has('edit-hold-loading'));advance(1999);assert.equal(edits,0);advance(1);assert.equal(edits,1);assert.equal(classes.size,0);
 let prevented=false;listeners.click({preventDefault(){prevented=true;},stopImmediatePropagation(){}});assert.equal(prevented,true);listeners.pointerup();advance(501);
 down();advance(1000);listeners.pointermove({pointerId:1,clientX:20,clientY:0});advance(3000);assert.equal(edits,1);assert.equal(classes.size,0);
 down();advance(500);listeners.pointerup();advance(3000);assert.equal(edits,1);
 c.state.habits[0].assignedBy=7;down();advance(3000);assert.equal(edits,1);
});
