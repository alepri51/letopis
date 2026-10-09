# Генератор векторов v5 (план, §2.3, §7.3.6) — независимая реализация на стандартной библиотеке Python.
# Запуск: python -I lib/test/vectors/gen_v5.py  (пишет v5.json рядом с собой)
import json
import os
import uuid

t1 = uuid.UUID('2eba6d0a-1edd-4bb6-a85a-a703dab49035')
t2 = uuid.UUID('7d3f0c4e-9b1a-4c55-8f2e-1a2b3c4d5e6f')
master = '0f8fad5b-d9cb-469f-a165-70867728950e'
cases = [
    ('кириллица', t1, 'Service', ['Стрижка']),
    ('несколько значений, конец и время', t1, 'slot', [master, '2026-10-07T10:00:00.000Z']),
    ('кавычки и обратная косая черта', t1, 'Note', ['he said "hi" \\ bye']),
    ('управляющие символы', t1, 'Note', ['a\nb\tc\r\x01\x1f\b\f']),
    ('эмодзи', t1, 'Tag', ['\U0001F642 ok']),
    ('пустая строка', t1, 'Tag', ['']),
    ('другой арендатор', t2, 'Service', ['Стрижка']),
    ('класс-брат', t1, 'Product', ['Стрижка']),
    ('DEL и юникод', t1, 'Note', ['x\x7fy é ß']),
]
out = []
for title, ns, cls, values in cases:
    name = json.dumps([cls] + values, ensure_ascii=False, separators=(', ', ':'))
    out.append({'title': title, 'tenant': str(ns), 'class': cls, 'values': values, 'name': name,
                'id': str(uuid.uuid5(ns, name))})
doc = {
    '$comment': 'Векторы v5 (план, §2.3, §7.3.6). Рассчитаны независимой реализацией: модуль uuid стандартной '
                'библиотеки Python, имя — json.dumps([класс, *значения], ensure_ascii=False, separators=(", ", ":")). '
                'Генератор — gen_v5.py рядом. Не редактировать руками.',
    'vectors': out,
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'v5.json')
with open(path, 'w', encoding='utf-8', newline='\n') as f:
    f.write(json.dumps(doc, ensure_ascii=False, indent=2) + '\n')
print(len(out))
