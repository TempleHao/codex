"use client";

import { AREAS, type Area, type WorkspaceData } from "@/lib/types";
import type { LifeData } from "@/lib/life";
import { chinaToday } from "@/lib/dates";
import { formatReadingSeconds } from "@/lib/reading";

const IDEAS: Record<Area, string> = {
  生活: "琐事、家人、财务和日常安排", 衣着: "衣柜整理、换季与购买计划", 饮食: "做饭、采购与想尝试的味道",
  居住: "收纳、家务和居住环境", 出行: "通勤、旅行与出发前的准备", 影音: "想看的电影、想听的音乐",
  阅读: "书架、划线与读完后的行动", 思考: "想法、困惑和慢慢形成的判断", 工作: "项目、学习与职业规划",
  健康: "运动、休息、体检和照顾自己", 其他: "暂时还不需要归类的事情",
};

export default function LifePanel({ data, life, today, onOpenArea, onCreateTask, onOpenReading, onOpenThoughts }: {
  data: WorkspaceData; life: LifeData; today: string;
  onOpenArea: (area: Area) => void;
  onCreateTask: (area: Area) => void;
  onOpenReading: () => void;
  onOpenThoughts: () => void;
}) {
  const weekStart = today ? new Date(`${today}T12:00:00+08:00`) : null;
  if (weekStart) weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const since = weekStart ? chinaToday(weekStart) : "";
  const inWeek = (timestamp: string | null) => Boolean(timestamp && since && chinaToday(new Date(timestamp)) >= since && chinaToday(new Date(timestamp)) <= today);
  const finished = data.tasks.filter(task => inWeek(task.completedAt));
  const thoughts = life.thoughts.filter(thought => inWeek(thought.createdAt));
  const daily = (life.reading.stats?.dailySeconds ?? []).filter(day => day.date >= since && day.date <= today);
  return <section className="life-panel" aria-label="生活全景">
    <header className="life-intro"><p className="eyebrow">MAKE ROOM FOR YOUR WHOLE LIFE</p><h1>让生活的每一面，<br/><span>都有一点着落。</span></h1><p>从衣食住行到工作与健康，先记下可以做的一小步。阅读和思考，也能长出行动。</p></header>
    <section className="life-review" aria-labelledby="life-review-heading"><div><p className="section-kicker">THIS WEEK, SO FAR</p><h2 id="life-review-heading">这周留下了什么</h2><p>{since ? `${since} 起 · 中国标准时间` : "正在打开本周记录"}</p></div><div className="life-review-numbers"><span><strong>{finished.length}</strong>件完成的事</span><span><strong>{thoughts.length}</strong>篇新的思考</span><span><strong>{daily.length ? formatReadingSeconds(daily.reduce((sum, day) => sum + day.seconds, 0)) : "—"}</strong>已导入的阅读时长</span></div>{finished.length > 0 && <ul>{finished.slice(0, 3).map(task => <li key={task.id}>✓ {task.title}</li>)}</ul>}</section>
    <div className="life-area-grid">{AREAS.map(area => {
      const tasks = data.tasks.filter(task => task.area === area);
      const todo = tasks.filter(task => task.status === "todo");
      const done = tasks.length - todo.length;
      return <article className="life-area-card" key={area}><div className="life-area-heading"><span className="life-area-mark">{area.slice(0, 1)}</span><h2>{area}</h2><span>{todo.length} 件待办</span></div><p>{IDEAS[area]}</p><div className="life-area-preview">{todo.length ? todo.slice(0, 2).map(task => <button key={task.id} onClick={() => onOpenArea(area)}>{task.title}</button>) : <span>还没有安排，留一点空白也很好。</span>}</div><div className="life-area-actions"><button className="text-button" onClick={() => onCreateTask(area)}>＋ 记一件事</button><button className="text-button" onClick={() => onOpenArea(area)}>查看待办{done > 0 ? ` · 已完成 ${done}` : ""} →</button></div>{area === "阅读" && <button className="life-domain-link" onClick={onOpenReading}>打开我的书架 · {life.reading.books.length} 本 →</button>}{area === "思考" && <button className="life-domain-link" onClick={onOpenThoughts}>打开我的思考 · {life.thoughts.length} 篇 →</button>}</article>;
    })}</div>
  </section>;
}
