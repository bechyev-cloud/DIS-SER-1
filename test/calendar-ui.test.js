'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('calendar separates personal, received and all coach groups and isolates accounts',async()=>{
 const html=fs.readFileSync(path.resolve(__dirname,'../../user-pwa/index.html'),'utf8');
 const code=html.slice(html.indexOf("  var calendarFilter = 'mine'"),html.indexOf('  function applyCalendarFilter'));
 const store=new Map(),els=new Map();let mode='student',calls=0;
 const el=id=>{if(!els.has(id))els.set(id,{classList:{toggle(){}},setAttribute(){},addEventListener(){}});return els.get(id);};
 const c={currentUser:{id:3,role:'USER'},currentView:'calendar',trainingMode:()=>mode,trainingPreferenceKey:()=>String(c.currentUser.id),isLoggedIn:()=>!!c.currentUser,localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},document:{getElementById:el,body:{classList:{toggle(){}}}},state:{habits:[{id:'personal'},{id:'received',assignedBy:9}]},renderCalendar(){},api:{get:async url=>{calls++;return url==='/groups'?{groups:[{id:1,name:'A'},{id:2,name:'B'}]}:{habits:[{id:url,name:'Task'}]};}}};
 vm.createContext(c);vm.runInContext(code,c);c.syncCalendarChoice();assert.equal(c.calendarTasks()[0].id,'personal');c.chooseCalendar('trainer');assert.equal(c.calendarTasks()[0].id,'received');
 mode='trainer';c.syncCalendarChoice();assert.equal(c.calendarFilter,'mine');c.chooseCalendar('trainer');c.loadCoachCalendar();assert.equal(calls,0);assert.ok(c.coachCalendar.error);
 c.currentUser={id:9,role:'TRAINER'};c.syncCalendarChoice();c.chooseCalendar('trainer');c.loadCoachCalendar();await new Promise(setImmediate);assert.equal(c.calendarTasks().length,2);assert.equal(c.calendarTasks()[1].groupName,'B');assert.equal(calls,3);
 c.currentUser={id:10,role:'TRAINER'};c.syncCalendarChoice();c.chooseCalendar('trainer');assert.equal(c.calendarTasks().length,0);
 mode='student';c.currentUser={id:3,role:'USER'};c.syncCalendarChoice();assert.equal(c.calendarFilter,'trainer');assert.equal(c.calendarTasks()[0].id,'received');
});
