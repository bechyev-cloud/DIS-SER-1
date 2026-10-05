'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),G=require('../../shared/goal-progress');
const goal=(repeat='daily',total=1000,daily=50)=>({id:'goal',config:{goal:{enabled:true,repeat,total,daily,mode:'percent',buttons:[{value:10}]}}});
test('daily quota is separate while total accumulates, including last partial day',()=>{
 const h=goal('daily',120),p={};
 assert.equal(G.buttonAmount(h,p,'2026-10-01',20),10);
 assert.equal(G.add(h,p,'2026-10-01',80).today,50);
 assert.equal(G.summary(h,p,'2026-10-02').percent,0);
 assert.equal(G.add(h,p,'2026-10-02',50).total,100);
 assert.equal(G.summary(h,p,'2026-10-03').target,20);
 assert.equal(G.add(h,p,'2026-10-03',50).total,120);
 assert.equal(G.summary(h,p,'2026-10-04').completedBefore,true);
 assert.equal(G.add(h,p,'2026-10-03',-20).total,100);
 assert.equal(G.summary(h,p,'2026-10-03').percent,0);
});
test('one-off carries progress across dates, caps total and supports decimals',()=>{
 const h=goal('once',100,100),p={};
 G.add(h,p,'2026-10-01',20);
 assert.equal(G.summary(h,p,'2026-10-02').percent,20);
 G.add(h,p,'2026-10-02',79.99);
 assert.equal(G.summary(h,p,'2026-10-02').percent,99);
 assert.equal(G.add(h,p,'2026-10-02',50).total,100);
 assert.equal(p['2026-10-02'].goal.goalLastDelta,.01);
 assert.equal(G.add(h,p,'2026-10-02',-.01).total,99.99);
 assert.equal(G.add(h,p,'2026-10-01',100).all,100);
});
test('goals stay isolated, legacy cards disabled, invalid increment rejected',()=>{
 const h=goal(),p={};G.add(h,p,'2026-10-01',25);
 assert.equal(G.summary({...h,id:'other'},p,'2026-10-01').total,0);
 assert.equal(G.config({config:{}}),null);
 assert.equal(G.add(h,p,'2026-10-01',NaN),null);
 h.config.goal.mode='count';assert.equal(G.buttonAmount(h,p,'2026-10-01',2.5),2.5);
});
