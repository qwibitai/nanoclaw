# APIs Nutricionais Externas

> Endpoints, autenticação e exemplos de uso das 3 APIs que a Naia consulta quando a base local não cobre.
> **Princípio:** sempre tenta a base local primeiro (TACO essencial, produtos brasileiros, pratos de restaurante). API só quando não tiver dado local.
> **Auth:** USDA via OneCLI (header `X-Api-Key` injetado automaticamente). TACO e OpenFoodFacts são públicas, sem chave.

---

## Heurística de qual API usar

```
Caso                                          → 1ª escolha            → Fallback
─────────────────────────────────────────────────────────────────────────────────
Alimento BR tradicional não listado           → TACO CSV completo     → estimativa
Produto industrializado BR (rótulo)           → OpenFoodFacts         → USDA
Frase em linguagem natural ("100g frango")    → decompor + TACO/USDA  → estimativa
Alimento internacional não-processado         → USDA FoodData Central → estimativa
Prato composto BR fora da base local          → base local de pratos  → decompor
Receita complexa (vários ingredientes)        → decompor + TACO/USDA  → estimativa
```

> **Nota:** quando Jonas mandar uma frase composta ("comi 200g frango + 100g arroz + 1 maçã"), a Naia **decompõe** e consulta cada item em TACO/USDA separadamente. Some manual + apresenta o total. Não existe API de "linguagem natural → macros" no stack — é decomposição manual orientada por base local.

---

## 1. TACO — Tabela Brasileira de Composição de Alimentos

### O que é
Base oficial brasileira de composição de alimentos. UNICAMP, NEPA. **Padrão-ouro para alimentos BR não processados.**

### Acesso
- **Sem chave de API** — é um CSV/PDF público.
- A versão essencial está em `tabela-taco-essencial.md` (~150 alimentos mais comuns).
- Para a tabela completa (~600 alimentos), o CSV está disponível para download:
  - URL canônica: `https://www.nepa.unicamp.br/taco/contar/taco_4_edicao_ampliada_e_revisada.pdf` (PDF oficial)
  - Mirrors em CSV variam — as colunas sempre são: nome, kcal, ptn, lip, cho, fib, ca, mg, mn, p, fe, na, k, cu, zn, retinol, RE, RAE, tiamina, riboflavina, piridoxina, niacina, vit_C

### Quando usar
- Quando o alimento brasileiro não está em `tabela-taco-essencial.md`.
- Quando precisa de micronutrientes (ferro, cálcio, vitaminas) — TACO é mais completa que outras APIs.

### Como usar (em código, se disponível)
```python
import pandas as pd
taco = pd.read_csv("taco_completa.csv", encoding="utf-8")
resultado = taco[taco["nome"].str.contains("açaí", case=False, na=False)]
print(resultado[["nome", "kcal", "ptn", "lip", "cho", "fib"]].to_dict("records"))
```

### Limitações
- Só alimentos in natura ou minimamente processados — não tem marcas comerciais.
- Para produtos industrializados, usar OpenFoodFacts.

---

## 2. OpenFoodFacts (OFF)

### O que é
Base colaborativa global de produtos alimentícios industrializados. Cobertura BR muito boa (>500 mil produtos brasileiros). **Ótima quando Jonas manda o código de barras.**

### Acesso
- **Pública e sem chave** — REST API simples.
- Documentação: https://openfoodfacts.github.io/openfoodfacts-server/api/

### Endpoints principais

#### A. Buscar por código de barras (preferido)
```
GET https://world.openfoodfacts.org/api/v2/product/{codigo_barras}.json
```

Exemplo (Yopro 25g 250g):
```
GET https://world.openfoodfacts.org/api/v2/product/7891025126911.json
```

Resposta (campos importantes):
```json
{
  "status": 1,
  "product": {
    "product_name": "Yopro 25g de Proteína Frutas Vermelhas",
    "brands": "Danone",
    "nutriments": {
      "energy-kcal_100g": 52,
      "proteins_100g": 10.0,
      "carbohydrates_100g": 2.4,
      "sugars_100g": 2.2,
      "fat_100g": 0.6,
      "fiber_100g": 0,
      "sodium_100g": 0.04
    },
    "serving_size": "250g",
    "nutriscore_grade": "b",
    "ingredients_text_pt": "Leite desnatado, proteína do leite, ..."
  }
}
```

#### B. Buscar por nome
```
GET https://world.openfoodfacts.org/cgi/search.pl?search_terms={nome}&search_simple=1&action=process&json=1&page_size=5&countries_tags=brazil
```

Exemplo:
```
GET https://world.openfoodfacts.org/cgi/search.pl?search_terms=wickbold+integral&search_simple=1&action=process&json=1&page_size=5&countries_tags=brazil
```

### Headers recomendados
```
User-Agent: NaiaAgent/1.0 (jonas@zoryon.co)
```
*OFF pede identificação para logs — ajuda a comunidade.*

### Quando usar
- Jonas manda código de barras de um produto.
- Jonas pergunta sobre marca específica que não está em `produtos-brasileiros.md`.
- Precisa de Nutri-Score, NOVA score (nível de processamento), lista de ingredientes.

### Limitações
- Qualidade dos dados varia (é colaborativo). Para marcas top brasileiras, dados são bons. Para marcas pequenas, pode estar desatualizado.
- Sempre comparar resposta com o rótulo na foto, se Jonas mandou.

---

## 3. USDA FoodData Central

### O que é
Base oficial do Departamento de Agricultura dos EUA. **Padrão-ouro internacional**, dados muito confiáveis. Inclui USDA Branded (produtos comerciais), Foundation Foods (alimentos in natura) e SR Legacy.

### Acesso
- **Chave já configurada no OneCLI vault** (host: `api.nal.usda.gov`, header: `X-Api-Key`)
- A Naia **não vê nem manipula a chave** — basta fazer a chamada HTTPS, o gateway injeta o header automaticamente.
- Limite: 1.000 requisições por hora.

### Endpoints principais

#### A. Buscar alimento
```
GET https://api.nal.usda.gov/fdc/v1/foods/search?query={termo}&pageSize=5
Header: X-Api-Key: <injetado pelo OneCLI>
```

Exemplo:
```
GET https://api.nal.usda.gov/fdc/v1/foods/search?query=greek+yogurt+nonfat&pageSize=5
```

> **NÃO** anexe `?api_key=...` na URL — o OneCLI injeta o header. Se você passar query string, fica vazia (sem auth) e a chamada falha 403.

Resposta:
```json
{
  "totalHits": 250,
  "foods": [
    {
      "fdcId": 170888,
      "description": "Yogurt, Greek, plain, nonfat",
      "foodCategory": "Dairy and Egg Products",
      "foodNutrients": [
        {"nutrientName": "Protein", "value": 10.19, "unitName": "G"},
        {"nutrientName": "Total lipid (fat)", "value": 0.39, "unitName": "G"},
        {"nutrientName": "Carbohydrate", "value": 3.6, "unitName": "G"},
        {"nutrientName": "Energy", "value": 59, "unitName": "KCAL"}
      ]
    }
  ]
}
```

#### B. Detalhes de um alimento específico
```
GET https://api.nal.usda.gov/fdc/v1/food/{fdcId}
Header: X-Api-Key: <injetado pelo OneCLI>
```

### Quando usar
- Alimento internacional (granolas importadas, suplementos americanos).
- Quando OpenFoodFacts não tem o produto.
- Quando precisa de informações nutricionais super-detalhadas (aminoácidos, ácidos graxos, etc).

### Limitações
- Em inglês — Naia precisa traduzir o nome do alimento antes de buscar.
- Cobertura BR é fraca (poucos produtos brasileiros).
- Unidades em padrão americano (cups, oz, lb) — precisa converter.

### Tradução PT→EN para buscar na USDA
Antes de chamar, traduza mentalmente:
- "frango" → "chicken"
- "arroz integral" → "brown rice"
- "feijão preto" → "black beans"
- "tapioca" → "cassava flour" ou "tapioca starch"
- "mandioca" → "cassava"
- "aveia" → "oats"
- "batata doce" → "sweet potato"
- "ricota" → "ricotta"
- "queijo branco minas" → "queso fresco" (mais próximo) ou usar TACO direto

---

## Protocolo da Naia ao consultar uma API

Quando a base local não cobre, antes de retornar a resposta:

1. **Anuncia a fonte** — "Consultando OpenFoodFacts..." (uma frase curta).
2. **Faz a chamada** com os parâmetros corretos.
3. **Valida a resposta:**
   - Se nutrientes parecem absurdos (ex: 5g proteína em 100g de carne), descartar e tentar outra API.
   - Se a porção da API não bate com a porção real, ajustar proporcionalmente (regra de três).
4. **Apresenta o resultado citando a fonte:**
   > "Segundo o OpenFoodFacts, esse iogurte tem 25g de proteína e 6g de açúcar por garrafa. ✅ Aprovado para o plano."
5. **Se a API falhar:**
   - Tentar a próxima na hierarquia.
   - Se todas falharem, dar **estimativa avisada**: "Não tenho dado preciso para esse item. Estimativa: ~X kcal, ~Y g de proteína. Para precisão, mande o rótulo."

---

## Cache local sugerido

Para evitar chamadas repetidas, a Naia pode manter um cache em memória de:
- Últimos 50 alimentos consultados nesta conversa.
- Itens recorrentes da rotina do Jonas (frango, arroz, ovo, Yopro, etc) — esses já estão na base local, não precisa cache.

Quando um produto novo é validado e Jonas confirma que será recorrente, sugerir adicionar à base local (`produtos-brasileiros.md`) — Jonas decide se aceita.

---

## Fallback final: estimativa baseada em ingredientes

Se nenhuma API tiver o item exato, a Naia decompõe em ingredientes e soma — usando TACO essencial como referência por componente:

Exemplo — "Comi um pão de queijo grande":
1. Não está nas bases.
2. Decomposição mental: 1 pão de queijo grande ≈ 60g, composto por queijo (15g), polvilho (35g), ovo (5g), leite/óleo (5g).
3. Lookup de cada componente em `tabela-taco-essencial.md` (ou USDA pra polvilho, se não tiver).
4. Estimativa somada: ~190 kcal, 5g proteína, 22g carbo, 9g gordura.
5. Avisar: "Estimativa baseada em ingredientes (~190 kcal). Pão de queijo é 'curinga' difícil. Conta como 1 carbo no plano, sem proteína suficiente — combine com whey ou ovo."
