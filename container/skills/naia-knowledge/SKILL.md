---
name: naia-knowledge
description: Base de conhecimento operacional da Naia (consultoria nutricional pessoal de Jonas Silva). Use SEMPRE que: (1) responder dúvida sobre composição nutricional de alimento brasileiro ou produto industrializado BR; (2) analisar foto de cardápio de restaurante e ranquear pratos; (3) calcular macros de uma refeição ou estimar calorias; (4) ler rótulo de produto e dar veredito de encaixe no plano High Carb; (5) sugerir substituições dentro do plano alimentar; (6) consultar APIs externas de nutrição (TACO, OpenFoodFacts, USDA); (7) interpretar medidas caseiras ('1 colher de sopa de arroz', '1 concha de feijão'); (8) detalhar receitas do plano da nutricionista Isabela; (9) precificar pratos típicos de restaurante brasileiro em macros estimados. Carregue antes de responder qualquer pergunta sobre alimento, prato, produto, ou cardápio.
---

# Naia Knowledge — Base operacional

Conjunto de referências práticas que a Naia consulta para dar respostas precisas, contextualizadas e baseadas em dados reais — não em estimativa genérica de IA.

## Quando carregar cada arquivo

| Cenário | Arquivos a carregar |
|---|---|
| "Quanto de proteína tem em 100g de frango?" / "Calorias do baião de dois?" | `tabela-taco-essencial.md` (1ª escolha) → `apis-nutricionais.md` se não estiver na tabela |
| "Esse iogurte serve para o plano?" / análise de rótulo de marca BR | `produtos-brasileiros.md` (1ª escolha) → `apis-nutricionais.md` (OpenFoodFacts) |
| Foto de cardápio de restaurante / análise de menu | `pratos-restaurante-br.md` + `medidas-caseiras.md` |
| "Quanto pesa 1 colher de sopa de arroz cozido?" | `medidas-caseiras.md` |
| "Como faço a crepioca do plano?" / detalhe de receita | `receitas-liti-expandidas.md` |
| Alimento estrangeiro / ingrediente raro / dúvida não coberta | `apis-nutricionais.md` (USDA via OneCLI) |

## Heurística de decisão rápida

```
Pergunta sobre alimento ou prato?
├─ É brasileiro tradicional (feijão, mandioca, açaí, tapioca, baião…)?
│   └─ tabela-taco-essencial.md
├─ É produto industrializado com marca BR (Yopro, Piracanjuba, Wickbold…)?
│   └─ produtos-brasileiros.md
├─ É prato composto de restaurante (parmegiana, escondidinho, feijoada…)?
│   └─ pratos-restaurante-br.md
├─ É medida caseira (colher, prato, concha, fatia…)?
│   └─ medidas-caseiras.md
├─ É receita do plano da Isabela (crepioca, panqueca, mousse proteica…)?
│   └─ receitas-liti-expandidas.md
└─ Não cobrı́ aqui? → apis-nutricionais.md (consulta API externa)
```

## Princípios de uso

1. **Sempre prefira a base local.** Ela é instantânea e tem dados validados para o contexto BR. APIs externas só quando a base não cobre.
2. **Quando consultar API, cite a fonte.** "Segundo o OpenFoodFacts, esse iogurte tem X g de proteína…"
3. **Quando estimar (não tiver fonte), avise.** "Estimativa: ~X g de proteína. Para precisão, mande o rótulo."
4. **Conecte ao plano High Carb sempre.** Não responda só "100g de frango tem 23g de proteína" — diga "está dentro da porção de 130g do almoço, dá ~30g de proteína, exatamente o que o plano pede."
5. **Para Jonas, o que importa é DECISÃO.** Ele não está fazendo estudo nutricional, está decidindo o que comer agora.
